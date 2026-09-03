// stdio and Streamable HTTP transports over the shared server definition.

import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { McpConfig } from "./connection.js";
import { ConnectionRegistry } from "./registry.js";
import { createServer } from "./server.js";
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

function installShutdown(registry: ConnectionRegistry, extra?: () => Promise<void>): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await extra?.();
      await registry.close();
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
  installShutdown(registry, () => server.close());
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
}

/**
 * Runs the server as stateless Streamable HTTP on `/mcp`. Every request
 * gets its own McpServer + transport (the SDK's stateless pattern) while
 * sharing the single GizmoSQL connection.
 *
 * Authentication: when GIZMOSQL_MCP_BEARER_TOKEN is set every request must
 * carry `Authorization: Bearer <token>`. OAuth is a future extension point:
 * replace `authorize()` with an OAuth token verifier.
 */
export async function startHttp(config: McpConfig, options: HttpOptions): Promise<http.Server> {
  const registry = new ConnectionRegistry(config, log);
  const bearer = config.mcpBearerToken;

  const authorize = (req: http.IncomingMessage): boolean => {
    if (!bearer) return true;
    return bearerMatches(req.headers.authorization, bearer);
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: PACKAGE_NAME, version: PACKAGE_VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. The MCP endpoint is /mcp.");
      return;
    }
    if (!authorize(req)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
      return;
    }
    const server = createServer({ registry, config, transport: "http" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`[gizmosql-mcp] request error: ${registry.redact(err instanceof Error ? err.message : String(err))}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  installShutdown(registry, () => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const addr = httpServer.address();
  const shown = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${options.host}:${options.port}`;
  log(
    `[gizmosql-mcp] ${PACKAGE_NAME} ${PACKAGE_VERSION} listening on http://${shown}/mcp ` +
      `(${describeTargets(config)}, writes ${config.allowWrites ? "enabled" : "disabled"}, ` +
      `auth ${bearer ? "bearer" : "none"})`,
  );
  return httpServer;
}
