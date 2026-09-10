// Integration tests for the hosted HTTP transport: per-user sessions under
// concurrency, idle expiry, and a tool-wide result-shape sweep. The MCP
// server runs in-process (startHttp) in OAuth mode against a throwaway
// OpenID Connect issuer and a real GizmoSQL server (same target selection
// as tools.test.ts: GIZMOSQL_TEST_* or a Docker container).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type * as http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FlightSQLClient } from "@gizmodata/gizmosql-client";
import { Ajv2020 } from "ajv/dist/2020.js";

import { parseConfig } from "../../dist/connection.js";
import { startHttp } from "../../dist/transports.js";
import { FakeIssuer } from "../helpers/fake-issuer.ts";

const IMAGE = process.env.GIZMOSQL_TEST_IMAGE ?? "gizmodata/gizmosql:v1.38.1";
const USERNAME = process.env.GIZMOSQL_TEST_USERNAME ?? "gizmosql";
const PASSWORD = process.env.GIZMOSQL_TEST_PASSWORD ?? "gizmosql_mcp_test_password";
const CONTAINER = `gizmosql-mcp-sessions-${process.pid}`;
const PUBLIC_URL = "https://mcp.test.invalid/mcp";
const AUDIENCE = "api://gizmosql-mcp-test";

interface Target {
  host: string;
  port: number;
  cleanup: () => void;
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function adminClient(target: Target): FlightSQLClient {
  return new FlightSQLClient({ host: target.host, port: target.port, tlsSkipVerify: true, username: USERNAME, password: PASSWORD });
}

async function waitReady(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = adminClient({ host, port, cleanup: () => undefined });
    try {
      await client.execute("SELECT 1");
      await client.close();
      return;
    } catch (err) {
      lastError = err;
      await client.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`GizmoSQL at ${host}:${port} not ready: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function resolveTarget(): Promise<Target | null> {
  if (process.env.GIZMOSQL_TEST_HOST) {
    const host = process.env.GIZMOSQL_TEST_HOST;
    const port = Number(process.env.GIZMOSQL_TEST_PORT ?? 31337);
    await waitReady(host, port, 90000);
    return { host, port, cleanup: () => undefined };
  }
  if (!dockerAvailable()) return null;
  execFileSync("docker", [
    "run", "--detach", "--rm", "--tty", "--init",
    "--name", CONTAINER,
    "--publish", "127.0.0.1:0:31337",
    "--env", "TLS_ENABLED=1",
    "--env", `GIZMOSQL_USERNAME=${USERNAME}`,
    "--env", `GIZMOSQL_PASSWORD=${PASSWORD}`,
    IMAGE,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const cleanup = () => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  };
  try {
    const mapping = execFileSync("docker", ["port", CONTAINER, "31337/tcp"], { encoding: "utf8" });
    const port = Number(mapping.trim().split("\n")[0].split(":").pop());
    await waitReady("127.0.0.1", port, 90000);
    return { host: "127.0.0.1", port, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const target = await resolveTarget();

describe("hosted HTTP sessions", { skip: target ? false : "Docker not available and GIZMOSQL_TEST_HOST not set" }, () => {
  const idp = new FakeIssuer();
  const servers: http.Server[] = [];
  const clients: Client[] = [];

  /** Starts an in-process OAuth-mode HTTP server against the target. */
  async function startServer(extra: Record<string, string> = {}): Promise<string> {
    assert.ok(target);
    const config = parseConfig({
      GIZMOSQL_HOST: target.host,
      GIZMOSQL_PORT: String(target.port),
      GIZMOSQL_USERNAME: USERNAME,
      GIZMOSQL_PASSWORD: PASSWORD,
      GIZMOSQL_TLS_SKIP_VERIFY: "true",
      GIZMOSQL_DEFAULT_CATALOG: "memory",
      GIZMOSQL_DEFAULT_SCHEMA: "main",
      // A second connection to the same server so use_connection has something to switch to.
      GIZMOSQL_2_NAME: "second",
      GIZMOSQL_2_HOST: target.host,
      GIZMOSQL_2_PORT: String(target.port),
      GIZMOSQL_2_USERNAME: USERNAME,
      GIZMOSQL_2_PASSWORD: PASSWORD,
      GIZMOSQL_2_TLS_SKIP_VERIFY: "true",
      GIZMOSQL_MCP_PUBLIC_URL: PUBLIC_URL,
      GIZMOSQL_MCP_OAUTH_ISSUER: idp.issuer,
      GIZMOSQL_MCP_OAUTH_AUDIENCE: AUDIENCE,
      GIZMOSQL_MCP_OAUTH_ALLOW_INSECURE: "true",
      ...extra,
    });
    const server = await startHttp(config, { host: "127.0.0.1", port: 0, installSignalHandlers: false });
    servers.push(server);
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}/mcp`;
  }

  /** An MCP client authenticated as `sub` at the given server. */
  async function connectAs(url: string, sub: string): Promise<Client> {
    const token = await idp.token({ sub, email: `${sub}@example.com` }, { audience: AUDIENCE, expiresIn: "10m" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: `sessions-${sub}`, version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  before(async () => {
    assert.ok(target);
    await idp.start();
    // Fixtures: the same table name in two schemas with different contents,
    // so unqualified resolution reveals which search path a session has.
    const admin = adminClient(target);
    try {
      await admin.execute("CREATE SCHEMA IF NOT EXISTS memory.mcp_sess");
      await admin.execute("CREATE OR REPLACE TABLE memory.main.whoami AS SELECT 'main' AS schema_name");
      await admin.execute("CREATE OR REPLACE TABLE memory.mcp_sess.whoami AS SELECT 'mcp_sess' AS schema_name");
      await admin.execute(
        "CREATE OR REPLACE TABLE memory.main.mcp_sweep (id INTEGER PRIMARY KEY, name VARCHAR); INSERT INTO memory.main.mcp_sweep VALUES (1, 'one')",
      );
    } finally {
      await admin.close();
    }
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    await idp.stop();
    target?.cleanup();
  });

  const schemaSeenBy = async (client: Client) => {
    const r = await call(client, "run_query", { sql: "SELECT schema_name FROM whoami" });
    assert.equal(r.isError, undefined, textOf(r));
    return (r.structuredContent as { rows: string[][] }).rows[0][0];
  };

  it("advertises offline_access, warns when it is missing, and logs every rejected token", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const withRefresh = await startServer({ GIZMOSQL_MCP_OAUTH_SCOPES: `${PUBLIC_URL}/access_as_user openid offline_access` });
      assert.ok(!lines.some((l) => l.includes("does not include offline_access")), lines.join("\n"));
      const withoutRefresh = await startServer({ GIZMOSQL_MCP_OAUTH_SCOPES: `${PUBLIC_URL}/access_as_user` });
      assert.ok(lines.some((l) => l.includes("warning: GIZMOSQL_MCP_OAUTH_SCOPES does not include offline_access")), lines.join("\n"));

      // A token for another audience is rejected with the challenge Claude
      // uses to (re)authorize, and the rejection reason lands in the log.
      const foreign = await idp.token({ sub: "eve", email: "eve@example.com" }, { audience: "api://someone-else", expiresIn: "10m" });
      const res = await fetch(withRefresh, {
        method: "POST",
        headers: { authorization: `Bearer ${foreign}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /error="invalid_token"/u);
      assert.match(challenge, /scope="[^"]*\boffline_access\b[^"]*"/u);
      assert.ok(lines.some((l) => /unauthorized: .*"aud" claim/u.test(l)), lines.join("\n"));
      void withoutRefresh;
    } finally {
      console.error = original;
    }
  });

  it("keeps use_schema, use_connection and unqualified name resolution private to each user", async () => {
    const url = await startServer();
    const alice = await connectAs(url, "alice");
    const bob = await connectAs(url, "bob");

    assert.equal(await schemaSeenBy(alice), "main");
    assert.equal(await schemaSeenBy(bob), "main");

    const switched = await call(alice, "use_schema", { catalog: "memory", schema: "mcp_sess" });
    assert.equal(switched.isError, undefined, textOf(switched));
    assert.equal(await schemaSeenBy(alice), "mcp_sess", "alice sees her new search path");
    assert.equal(await schemaSeenBy(bob), "main", "bob's search path is untouched");

    const conn = await call(alice, "use_connection", { name: "second" });
    assert.equal(conn.isError, undefined, textOf(conn));
    const aliceInfo = (await call(alice, "server_info")).structuredContent as Record<string, unknown>;
    const bobInfo = (await call(bob, "server_info")).structuredContent as Record<string, unknown>;
    assert.equal(aliceInfo.current_connection, "second");
    assert.equal(bobInfo.current_connection, "default");
    assert.equal(aliceInfo.authenticated_user, "alice@example.com");
    assert.equal(bobInfo.authenticated_user, "bob@example.com");
    assert.equal(aliceInfo.session_scope, "per-user");
    assert.equal(bobInfo.session_scope, "per-user");
    assert.notEqual(aliceInfo.session_started, bobInfo.session_started);
    // Alice's search path applied to the connection she switched from; the
    // second connection starts from the configured defaults.
    assert.equal(await schemaSeenBy(alice), "main");
  });

  it("interleaves a burst of concurrent queries from several users without cross-talk", async () => {
    const url = await startServer();
    const users = await Promise.all(["carol", "dave", "erin"].map((u) => connectAs(url, u)));
    // Each user gets a distinct search path first.
    await call(users[0], "use_schema", { catalog: "memory", schema: "mcp_sess" });
    const expected = ["mcp_sess", "main", "main"];

    const burst = users.flatMap((client, ui) =>
      Array.from({ length: 12 }, (_, i) => ({
        client,
        ui,
        i,
        marker: ui * 1000 + i,
      })),
    );
    const results = await Promise.all(
      burst.map(async ({ client, ui, i, marker }) => {
        const r = await call(client, "run_query", {
          sql: "SELECT ?::INTEGER AS marker, schema_name FROM whoami",
          params: [marker],
        });
        return { ui, i, marker, r };
      }),
    );
    for (const { ui, marker, r } of results) {
      assert.equal(r.isError, undefined, textOf(r));
      const rows = (r.structuredContent as { rows: Array<[number, string]> }).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0], marker, "each response carries its own request's marker");
      assert.equal(rows[0][1], expected[ui], `user ${ui} resolved whoami in the wrong schema`);
    }
    assert.equal(results.length, 36);
  });

  it("expires an idle session: the next call succeeds on a fresh session, says so, and earlier state is gone", async () => {
    const url = await startServer({ GIZMOSQL_MCP_SESSION_IDLE_SECONDS: "1" });
    const frank = await connectAs(url, "frank");
    await call(frank, "use_schema", { catalog: "memory", schema: "mcp_sess" });
    assert.equal(await schemaSeenBy(frank), "mcp_sess");

    // Idle for longer than the timeout plus a sweep period.
    await new Promise((r) => setTimeout(r, 2600));

    const r = await call(frank, "run_query", { sql: "SELECT schema_name FROM whoami" });
    assert.equal(r.isError, undefined, "an expired session is not an error for the caller: " + textOf(r));
    assert.equal((r.structuredContent as { rows: string[][] }).rows[0][0], "main", "use_schema did not survive expiry");
    assert.match(textOf(r), /previous session expired after 1s idle/);
    const reset = (r.structuredContent as { session_reset?: { expired_at: string } }).session_reset;
    assert.ok(reset && !Number.isNaN(Date.parse(reset.expired_at)), "structured session_reset with a timestamp");
    assert.match((r.structuredContent as { mcp_server_version: string }).mcp_server_version, /^\d+\.\d+\.\d+/);

    // The notice is delivered once; the session then behaves normally.
    const again = await call(frank, "run_query", { sql: "SELECT 1 AS one" });
    assert.equal(again.isError, undefined);
    assert.doesNotMatch(textOf(again), /previous session expired/);
    assert.equal((again.structuredContent as { session_reset?: unknown }).session_reset, undefined);
  });

  it("every registered tool returns a well-formed success: structured content, a version stamp, and a valid output schema", async () => {
    const url = await startServer();
    const grace = await connectAs(url, "grace");
    const tools = (await grace.listTools()).tools;
    assert.ok(tools.length >= 10, "tool list came from the server");

    // Minimal valid arguments per tool. A new tool must be added here or
    // this test fails, so coverage cannot silently lapse.
    const minimalArgs: Record<string, Record<string, unknown>> = {
      list_connections: {},
      use_connection: { name: "default" },
      list_catalogs: {},
      list_schemas: { catalog: "memory" },
      list_tables: { catalog: "memory", schema: "main", like: "mcp_sweep" },
      describe_table: { table: "mcp_sweep", schema: "main", catalog: "memory" },
      use_schema: { catalog: "memory", schema: "main" },
      run_query: { sql: "SELECT id, name FROM memory.main.mcp_sweep" },
      explain_query: { sql: "SELECT id FROM memory.main.mcp_sweep" },
      server_info: {},
    };
    const ajv = new Ajv2020({ strict: false });

    for (const tool of tools) {
      const args = minimalArgs[tool.name];
      assert.ok(args, `no minimal arguments known for tool "${tool.name}"; add it to minimalArgs`);
      const r = await call(grace, tool.name, args);
      assert.equal(r.isError, undefined, `${tool.name}: ${textOf(r)}`);
      assert.ok(textOf(r).trim().length > 0, `${tool.name}: empty text content`);
      const structured = r.structuredContent as Record<string, unknown> | undefined;
      assert.ok(structured && Object.keys(structured).length > 0, `${tool.name}: structuredContent missing or empty`);
      assert.match(String(structured.mcp_server_version ?? ""), /^\d+\.\d+\.\d+/, `${tool.name}: mcp_server_version missing`);
      const meta = (r as { _meta?: { gizmosql_mcp?: { name?: string; version?: string } } })._meta?.gizmosql_mcp;
      assert.equal(meta?.name, "@gizmodata/gizmosql-mcp", `${tool.name}: _meta.gizmosql_mcp not stamped`);
      if (tool.outputSchema) {
        const validate = ajv.compile(tool.outputSchema);
        assert.ok(validate(structured), `${tool.name}: structuredContent does not match outputSchema: ${ajv.errorsText(validate.errors)}`);
      }
    }
  });
});
