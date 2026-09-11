// stdio and Streamable HTTP transports over the shared server definition.

import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { redactSecrets, type McpConfig } from "./connection.js";
import { OAuthError, OAuthVerifier, OFFLINE_ACCESS_SCOPE, protectedResourceMetadataPaths, type AuthenticatedUser } from "./oauth.js";
import { OAuthFacade, facadeMetadataPaths, facadeTokenPath } from "./oauth-facade.js";
import { ConnectionRegistry } from "./registry.js";
import { createServer } from "./server.js";
import { SessionStore, type SessionInfo } from "./sessions.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const log = (message: string) => console.error(message);

/** "host:port" for one connection, or "name=host:port, ..." for several. */
function describeTargets(config: McpConfig): string {
  if (config.connections.length === 1) {
    const c = config.connections[0];
    return `${c.host}:${c.port}`;
  }
  return config.connections.map((c) => `${c.name}=${c.host}:${c.port}`).join(", ");
}

function installShutdown(closeAll: () => Promise<void>, extra?: () => Promise<void>): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await extra?.();
      await closeAll();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Runs the server on stdio (Claude Desktop / `claude mcp add`). */
export async function startStdio(config: McpConfig): Promise<void> {
  const registry = new ConnectionRegistry(config, log);
  const server = createServer({ registry, config, transport: "stdio" });
  const transport = new StdioServerTransport();
  installShutdown(() => registry.close(), () => server.close());
  // When the client closes stdin the transport closes; exit cleanly.
  transport.onclose = () => {
    void registry.close().finally(() => process.exit(0));
  };
  await server.connect(transport);
  log(`[gizmosql-mcp] ${PACKAGE_NAME} ${PACKAGE_VERSION} ready on stdio (${describeTargets(config)}, writes ${config.allowWrites ? "enabled" : "disabled"})`);
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/iu.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Test hook: replaces the OAuth verifier built from the config. */
  verifier?: OAuthVerifier;
  /** Test hook: disables the SIGINT/SIGTERM handlers. */
  installSignalHandlers?: boolean;
}

/** Largest JSON-RPC request body accepted on /mcp. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** One audit line per JSON-RPC request: who called which method (and tool). */
function describeRequest(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const method = (m as { method?: unknown }).method;
    const id = (m as { id?: unknown }).id;
    if (typeof method !== "string" || id === undefined) continue; // responses and notifications
    if (method === "tools/call") {
      const name = (m as { params?: { name?: unknown } }).params?.name;
      out.push(`tools/call ${typeof name === "string" ? name : "?"}`);
    } else if (method === "resources/read") {
      const uri = (m as { params?: { uri?: unknown } }).params?.uri;
      out.push(`resources/read ${typeof uri === "string" ? uri : "?"}`);
    } else {
      out.push(method);
    }
  }
  return out;
}

type Authorization = { ok: true; user?: AuthenticatedUser } | { ok: false; status: 401 | 403; error: string; description: string; challenge: string };

/** Session key: one session per subject at the issuer. */
function sessionKey(issuer: string, user: AuthenticatedUser): string {
  return `${issuer}#${user.subject || user.name}`;
}

/**
 * Runs the server as stateless Streamable HTTP on `/mcp`. Every request
 * gets its own McpServer + transport (the SDK's stateless pattern). With
 * OAuth, each authenticated user also gets their own connection registry
 * (a SessionStore entry) so session state never crosses users; otherwise
 * one registry is shared by every client.
 *
 * Authentication, one of:
 *   - GIZMOSQL_MCP_OAUTH_ISSUER: the server is an OAuth 2.1 resource server.
 *     Bearer tokens are verified against the provider's JWKS; RFC 9728
 *     metadata is served under /.well-known/oauth-protected-resource so
 *     clients discover the provider; 401 responses carry the challenge.
 *   - GIZMOSQL_MCP_BEARER_TOKEN: a single static token compared in constant time.
 *   - neither: unauthenticated (local use only).
 */
export async function startHttp(config: McpConfig, options: HttpOptions): Promise<http.Server> {
  const bearer = config.mcpBearerToken;
  const oauth = config.mcpOAuth;
  const verifier = options.verifier ?? (oauth ? new OAuthVerifier(oauth, { log }) : undefined);
  // Per-user sessions need an identity, so they exist only with OAuth.
  const sessions = verifier
    ? new SessionStore(config, { idleSeconds: config.mcpSessionIdleSeconds, maxSessions: config.mcpMaxSessions, log })
    : undefined;
  const sharedRegistry = sessions ? undefined : new ConnectionRegistry(config, log);
  // Used only for redacting log lines; secrets are the same in every registry.
  const redact = (t: string) => redactSecrets(t, sharedRegistry ? sharedRegistry.secrets() : config.connections.flatMap((c) => [c.password]));
  const metadataPaths = new Set(oauth ? protectedResourceMetadataPaths(oauth.publicUrl) : []);
  // Token-proxy facade: Claude is pointed at this server's copy of the
  // provider metadata so refresh_token grants pass through handleToken.
  const facade =
    oauth && verifier && oauth.tokenProxy
      ? new OAuthFacade({ publicUrl: oauth.publicUrl, upstreamIssuer: oauth.issuer, scopes: oauth.scopes }, { log })
      : undefined;
  const facadePaths = new Set(facade ? facadeMetadataPaths() : []);

  const authorize = async (req: http.IncomingMessage): Promise<Authorization> => {
    if (verifier) {
      try {
        return { ok: true, user: await verifier.verify(req.headers.authorization) };
      } catch (err) {
        if (err instanceof OAuthError) {
          return {
            ok: false,
            status: err.status,
            error: err.code,
            description: err.message,
            challenge: err.code === "invalid_token" ? verifier.challenge(err.code, err.message) : "",
          };
        }
        throw err;
      }
    }
    if (bearer && !bearerMatches(req.headers.authorization, bearer)) {
      return { ok: false, status: 401, error: "invalid_token", description: "Bearer token required", challenge: "Bearer" };
    }
    return { ok: true };
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: PACKAGE_NAME, version: PACKAGE_VERSION }));
      return;
    }
    if (verifier && metadataPaths.has(url.pathname.replace(/\/+$/u, "") || "/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      res.end(JSON.stringify(verifier.protectedResourceMetadata(facade?.issuer)));
      return;
    }
    if (facade) {
      const path = url.pathname.replace(/\/+$/u, "");
      if (facadePaths.has(path)) {
        await facade.handleMetadata(req, res);
        return;
      }
      if (path === facadeTokenPath()) {
        await facade.handleToken(req, res);
        return;
      }
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. The MCP endpoint is /mcp.");
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
      return;
    }
    let auth: Authorization;
    try {
      auth = await authorize(req);
    } catch (err) {
      log(`[gizmosql-mcp] auth error: ${redact(err instanceof Error ? err.message : String(err))}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
      return;
    }
    if (!auth.ok) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (auth.challenge) headers["www-authenticate"] = auth.challenge;
      res.writeHead(auth.status, headers);
      res.end(JSON.stringify({ error: auth.error, error_description: auth.description }));
      // 401s are logged too: an expired token with no refresh token behind it
      // looks, from the client, like the connector silently dying.
      log(`[gizmosql-mcp] ${auth.status === 403 ? "forbidden" : "unauthorized"}: ${auth.description}`);
      return;
    }

    let parsedBody: unknown;
    if (req.method === "POST") {
      try {
        const raw = await readBody(req);
        parsedBody = raw === "" ? undefined : JSON.parse(raw);
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: err instanceof Error ? err.message : String(err) }));
        return;
      }
      const who = auth.user ? auth.user.name : "anonymous";
      for (const line of describeRequest(parsedBody)) log(`[gizmosql-mcp] ${who}: ${line}`);
    }

    let registry: ConnectionRegistry;
    let session: SessionInfo | undefined;
    if (sessions && verifier && auth.user) {
      const acquired = sessions.acquire(sessionKey(verifier.config.issuer, auth.user), auth.user.name);
      registry = acquired.registry;
      session = acquired.info;
    } else {
      registry = sharedRegistry!;
    }
    const server = createServer({
      registry,
      config,
      transport: "http",
      user: auth.user,
      session,
      acknowledgeSessionReset: session ? () => sessions?.acknowledgeReset(session.key) : undefined,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      log(`[gizmosql-mcp] request error: ${redact(err instanceof Error ? err.message : String(err))}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  const closeAll = async () => {
    await sessions?.close();
    await sharedRegistry?.close();
  };
  if (options.installSignalHandlers !== false) {
    installShutdown(closeAll, () => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  }
  httpServer.once("close", () => void closeAll());

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const addr = httpServer.address();
  const shown = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${options.host}:${options.port}`;
  const authMode = verifier
    ? `oauth ${verifier.config.issuer}${facade ? ` via token proxy ${facade.issuer}` : ""}, per-user sessions (idle ${config.mcpSessionIdleSeconds}s, max ${config.mcpMaxSessions})`
    : bearer
      ? "bearer"
      : "none";
  log(
    `[gizmosql-mcp] ${PACKAGE_NAME} ${PACKAGE_VERSION} listening on http://${shown}/mcp ` +
      `(${describeTargets(config)}, writes ${config.allowWrites ? "enabled" : "disabled"}, ` +
      `auth ${authMode})`,
  );
  if (verifier && !facade && /(^|\.)login\.microsoftonline\.com$/u.test(new URL(verifier.config.issuer).hostname)) {
    log(
      "[gizmosql-mcp] warning: Microsoft Entra ID rejects Claude's refresh_token requests unless the API scope is " +
        "re-sent (AADSTS90009); set GIZMOSQL_MCP_OAUTH_TOKEN_PROXY=true or users must reconnect every hour",
    );
  }
  if (verifier && !verifier.config.scopes.includes(OFFLINE_ACCESS_SCOPE)) {
    log(
      `[gizmosql-mcp] warning: GIZMOSQL_MCP_OAUTH_SCOPES does not include ${OFFLINE_ACCESS_SCOPE}; ` +
        "providers such as Microsoft Entra ID then issue no refresh token, and clients lose access " +
        "when the access token expires (about an hour) until the user reconnects the connector",
    );
  }
  return httpServer;
}
