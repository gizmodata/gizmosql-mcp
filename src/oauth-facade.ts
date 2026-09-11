// Authorization-server facade for providers whose refresh flow needs help.
//
// Claude refreshes an expiring access token by POSTing grant_type=
// refresh_token to the provider's token endpoint with only the OpenID
// Connect scopes (openid profile offline_access). Microsoft Entra ID then
// answers AADSTS90009 ("requesting a token for itself") because the request
// names no resource, and the connector dies at every access-token expiry.
// (anthropics/claude-ai-mcp#840 has the full forensic trail.)
//
// With GIZMOSQL_MCP_OAUTH_TOKEN_PROXY=true the MCP server publishes an
// authorization-server metadata document of its own, under
// <public origin>/oauth, that is the provider's document with two fields
// changed: `issuer` (this facade) and `token_endpoint` (this server). The
// token proxy forwards every request to the provider's token endpoint
// verbatim, except that a refresh_token grant also gets the configured API
// scope(s) and offline_access so the provider knows which resource to mint
// the new token for and returns a successor refresh token. Authorization
// still happens at the provider; tokens are never logged or stored.

import * as http from "node:http";

import { OFFLINE_ACCESS_SCOPE, discoverMetadata } from "./oauth.js";

/** Scopes that name no resource; a refresh carrying only these has nothing to renew against. */
export const OIDC_SCOPES = new Set(["openid", "profile", "email", OFFLINE_ACCESS_SCOPE]);

/** Path under the public origin where the facade lives. */
export const FACADE_PATH = "/oauth";

/** Largest token request body accepted (form-encoded credentials and a refresh token). */
const MAX_TOKEN_BODY_BYTES = 64 * 1024;

/** How long the provider's discovery document is cached. */
const METADATA_TTL_MS = 60 * 60 * 1000;

/** Time allowed for the provider's token endpoint (Claude waits 30s for a refresh). */
const UPSTREAM_TIMEOUT_MS = 20_000;

/** Facade issuer URL for a public MCP URL: same origin, FACADE_PATH. */
export function facadeIssuer(publicUrl: string): string {
  return `${new URL(publicUrl).origin}${FACADE_PATH}`;
}

/** Discovery paths at which the facade's metadata is served (OpenID Connect and RFC 8414, both placements). */
export function facadeMetadataPaths(): string[] {
  return [
    `${FACADE_PATH}/.well-known/openid-configuration`,
    `${FACADE_PATH}/.well-known/oauth-authorization-server`,
    `/.well-known/oauth-authorization-server${FACADE_PATH}`,
    `/.well-known/openid-configuration${FACADE_PATH}`,
  ];
}

/** Token endpoint path of the facade. */
export function facadeTokenPath(): string {
  return `${FACADE_PATH}/token`;
}

/**
 * Scope value for a refresh_token grant: what the client sent plus the
 * configured resource scope(s) and offline_access, without duplicates.
 * Returns the client's own value untouched when it already names a resource.
 */
export function refreshScope(requested: string | null, configured: string[]): { scope: string; injected: boolean } {
  const sent = (requested ?? "").split(/\s+/u).filter((s) => s !== "");
  if (sent.some((s) => !OIDC_SCOPES.has(s))) return { scope: sent.join(" "), injected: false };
  const merged = [...sent];
  for (const s of [...configured.filter((c) => !OIDC_SCOPES.has(c)), OFFLINE_ACCESS_SCOPE]) if (!merged.includes(s)) merged.push(s);
  return { scope: merged.join(" "), injected: merged.length !== sent.length };
}

export interface FacadeOptions {
  /** Test hook: replaces global fetch for discovery and the upstream token endpoint. */
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** One-line, secret-free description of a token response for the log. */
function describeTokenResponse(status: number, body: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return `HTTP ${status} (non-JSON body)`;
  }
  if (status >= 200 && status < 300) {
    const refresh = typeof parsed.refresh_token === "string" ? "yes" : "no";
    const expires = typeof parsed.expires_in === "number" ? `${parsed.expires_in}s` : "?";
    return `HTTP ${status} (refresh_token ${refresh}, expires_in ${expires})`;
  }
  const error = typeof parsed.error === "string" ? parsed.error : "error";
  const desc = typeof parsed.error_description === "string" ? parsed.error_description.split(/\r?\n/u)[0].slice(0, 200) : "";
  return `HTTP ${status} ${error}${desc ? `: ${desc}` : ""}`;
}

/** Serves the rewritten metadata and proxies the token endpoint for one provider. */
export class OAuthFacade {
  readonly issuer: string;
  private cached: { doc: Record<string, unknown>; at: number } | undefined;
  private loading: Promise<Record<string, unknown>> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(
    readonly config: { publicUrl: string; upstreamIssuer: string; scopes: string[] },
    options: FacadeOptions = {},
  ) {
    this.issuer = facadeIssuer(config.publicUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((m) => console.error(m));
  }

  /** The provider's discovery document with issuer and token_endpoint pointing at this facade. */
  async metadata(): Promise<Record<string, unknown>> {
    const upstream = await this.upstream();
    return { ...upstream, issuer: this.issuer, token_endpoint: `${new URL(this.config.publicUrl).origin}${facadeTokenPath()}` };
  }

  /** Handles GET on a metadata path. */
  async handleMetadata(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    try {
      const doc = await this.metadata();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      res.end(JSON.stringify(doc));
    } catch (err) {
      this.log(`[gizmosql-mcp] OAuth facade: discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", error_description: "authorization server discovery failed" }));
    }
  }

  /** Handles POST on the token path: forwards to the provider, fixing up refresh_token grants. */
  async handleToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: "expected application/x-www-form-urlencoded" }));
      return;
    }
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(await readBody(req, MAX_TOKEN_BODY_BYTES));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: err instanceof Error ? err.message : String(err) }));
      return;
    }
    const grant = params.get("grant_type") ?? "?";
    let injected = false;
    if (grant === "refresh_token") {
      const fixed = refreshScope(params.get("scope"), this.config.scopes);
      injected = fixed.injected;
      if (injected) params.set("scope", fixed.scope);
    }

    let upstreamTokenEndpoint: string;
    try {
      const doc = await this.upstream();
      if (typeof doc.token_endpoint !== "string") throw new Error("provider metadata has no token_endpoint");
      upstreamTokenEndpoint = doc.token_endpoint;
    } catch (err) {
      this.log(`[gizmosql-mcp] OAuth facade: ${grant} failed: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", error_description: "authorization server discovery failed" }));
      return;
    }

    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    // client_secret_basic: pass the client's credentials through untouched.
    if (typeof req.headers.authorization === "string") headers.authorization = req.headers.authorization;

    try {
      const upstream = await this.fetchImpl(upstreamTokenEndpoint, {
        method: "POST",
        headers,
        body: params.toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const body = await upstream.text();
      this.log(
        `[gizmosql-mcp] OAuth facade: ${grant}${injected ? " (scope added)" : ""} -> ${describeTokenResponse(upstream.status, body)}`,
      );
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      });
      res.end(body);
    } catch (err) {
      this.log(`[gizmosql-mcp] OAuth facade: ${grant} failed: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", error_description: "authorization server unreachable" }));
    }
  }

  private upstream(): Promise<Record<string, unknown>> {
    if (this.cached && Date.now() - this.cached.at < METADATA_TTL_MS) return Promise.resolve(this.cached.doc);
    if (!this.loading) {
      this.loading = discoverMetadata(this.config.upstreamIssuer, this.fetchImpl)
        .then((doc) => {
          this.cached = { doc, at: Date.now() };
          return doc;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }
}
