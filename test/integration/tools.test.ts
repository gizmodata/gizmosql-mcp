// Integration tests: run the MCP server against a real GizmoSQL server.
//
// Target selection:
//   - GIZMOSQL_TEST_HOST / GIZMOSQL_TEST_PORT / GIZMOSQL_TEST_USERNAME /
//     GIZMOSQL_TEST_PASSWORD point at an existing TLS server (CI service).
//   - Otherwise a `gizmodata/gizmosql` container (GIZMOSQL_TEST_IMAGE,
//     default v1.38.1) is started with Docker; the whole suite is skipped
//     when Docker is unavailable.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FlightSQLClient } from "@gizmodata/gizmosql-client";

const IMAGE = process.env.GIZMOSQL_TEST_IMAGE ?? "gizmodata/gizmosql:v1.38.1";
const USERNAME = process.env.GIZMOSQL_TEST_USERNAME ?? "gizmosql";
const PASSWORD = process.env.GIZMOSQL_TEST_PASSWORD ?? "gizmosql_mcp_test_password";
const CONTAINER = `gizmosql-mcp-test-${process.pid}`;

interface Target {
  host: string;
  port: number;
  cleanup: () => void;
}

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

async function waitReady(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new FlightSQLClient({ host, port, tlsSkipVerify: true, username: USERNAME, password: PASSWORD });
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

function serverEnv(target: Target, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return {
    ...base,
    GIZMOSQL_HOST: target.host,
    GIZMOSQL_PORT: String(target.port),
    GIZMOSQL_USERNAME: USERNAME,
    GIZMOSQL_PASSWORD: PASSWORD,
    GIZMOSQL_TLS_SKIP_VERIFY: "true",
    ...extra,
  };
}

async function stdioClient(target: Target, extra: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    env: serverEnv(target, extra),
    stderr: "pipe",
  });
  const client = new Client({ name: "gizmosql-mcp-integration", version: "0.0.0" });
  await client.connect(transport);
  return client;
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

describe("gizmosql-mcp integration", { skip: target ? false : "Docker not available and GIZMOSQL_TEST_HOST not set" }, () => {
  let ro: Client;
  let rw: Client;

  before(async () => {
    assert.ok(target);
    ro = await stdioClient(target, {
      GIZMOSQL_MAX_ROWS: "5",
      GIZMOSQL_MAX_CELL_CHARS: "10",
      GIZMOSQL_QUERY_TIMEOUT_SECONDS: "2",
    });
    rw = await stdioClient(target, { GIZMOSQL_ALLOW_WRITES: "true" });
  });

  after(async () => {
    await ro?.close().catch(() => undefined);
    await rw?.close().catch(() => undefined);
    target?.cleanup();
  });

  it("registers the read-only tool set (no execute_statement) and the schema resource", async () => {
    const tools = (await ro.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "describe_table",
      "explain_query",
      "list_catalogs",
      "list_schemas",
      "list_tables",
      "run_query",
      "server_info",
      "use_schema",
    ]);
    const runQuery = (await ro.listTools()).tools.find((t) => t.name === "run_query");
    assert.equal(runQuery?.annotations?.readOnlyHint, true);
    const templates = (await ro.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    assert.deepEqual(templates, ["gizmosql://schema/{catalog}/{schema}/{table}"]);
  });

  it("registers execute_statement when writes are enabled", async () => {
    const tools = (await rw.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("execute_statement"));
    const exec = (await rw.listTools()).tools.find((t) => t.name === "execute_statement");
    assert.equal(exec?.annotations?.destructiveHint, true);
  });

  it("server_info reports versions and redacts credentials", async () => {
    const r = await call(ro, "server_info");
    assert.equal(r.isError, undefined);
    const text = textOf(r);
    assert.match(text, /gizmosql_version: v\d+\.\d+\.\d+/);
    assert.match(text, /duckdb_version: v\d+/);
    assert.match(text, /connection_uri: gizmosql:\/\/gizmosql:\*\*\*@/);
    assert.ok(!text.includes(PASSWORD));
    assert.equal((r.structuredContent as { allow_writes: boolean }).allow_writes, false);
  });

  it("execute_statement creates and populates a table", async () => {
    await call(rw, "execute_statement", { sql: "DROP TABLE IF EXISTS mcp_it" });
    const created = await call(rw, "execute_statement", {
      sql: "CREATE TABLE mcp_it (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, amount DECIMAL(10,2), seen_at TIMESTAMP)",
    });
    assert.equal(created.isError, undefined, textOf(created));
    const inserted = await call(rw, "execute_statement", {
      sql: "INSERT INTO mcp_it SELECT range, 'name-' || range || ' with a long suffix', range * 1.25, TIMESTAMP '2024-01-02 03:04:05' FROM range(20)",
    });
    assert.equal(inserted.isError, undefined, textOf(inserted));
    assert.equal((inserted.structuredContent as { affected_rows: number }).affected_rows, 20);
    const bound = await call(rw, "execute_statement", {
      sql: "INSERT INTO mcp_it VALUES (?, ?, ?, ?)",
      params: [100, "bound", { type: "number", value: "9.99" }, "2024-05-06T07:08:09Z"],
    });
    assert.equal(bound.isError, undefined, textOf(bound));
    assert.equal((bound.structuredContent as { affected_rows: number }).affected_rows, 1);
  });

  it("metadata tools see the table", async () => {
    const catalogs = await call(ro, "list_catalogs");
    assert.ok((catalogs.structuredContent as { catalogs: string[] }).catalogs.includes("memory"));
    const schemas = await call(ro, "list_schemas", { catalog: "memory" });
    assert.match(textOf(schemas), /\| memory \| main \|/);
    const tables = await call(ro, "list_tables", { catalog: "memory", like: "mcp%" });
    assert.match(textOf(tables), /\| memory \| main \| mcp_it \| BASE TABLE \|/);
    const described = await call(ro, "describe_table", { table: "mcp_it" });
    assert.equal(described.isError, undefined, textOf(described));
    const text = textOf(described);
    assert.match(text, /\*\*memory\.main\.mcp_it\*\* \(BASE TABLE\)/);
    assert.match(text, /\| amount \| DECIMAL\(10,2\) \| YES \|/);
    assert.match(text, /\| name \| VARCHAR \| NO \|/);
    assert.match(text, /PRIMARY KEY/);
    const missing = await call(ro, "describe_table", { table: "does_not_exist" });
    assert.equal(missing.isError, true);
  });

  it("run_query enforces max_rows, truncates cells and returns structured rows", async () => {
    const r = await call(ro, "run_query", { sql: "SELECT id, name, amount, seen_at FROM mcp_it ORDER BY id" });
    assert.equal(r.isError, undefined, textOf(r));
    const s = r.structuredContent as { rows: unknown[][]; row_count: number; truncated: boolean };
    assert.equal(s.row_count, 5);
    assert.equal(s.truncated, true);
    assert.deepEqual(s.rows[0], [0, "name-0 with a long suffix", "0.00", "2024-01-02T03:04:05"]);
    const text = textOf(r);
    assert.match(text, /\| name-0 wit… \|/); // 10 chars + ellipsis
    assert.match(text, /5 rows returned \(truncated: more rows exist beyond max_rows=5\)/);

    const smaller = await call(ro, "run_query", { sql: "SELECT id FROM mcp_it ORDER BY id", max_rows: 2 });
    assert.equal((smaller.structuredContent as { row_count: number }).row_count, 2);
    const capped = await call(ro, "run_query", { sql: "SELECT id FROM mcp_it ORDER BY id", max_rows: 1000 });
    assert.equal((capped.structuredContent as { row_count: number }).row_count, 5);
  });

  it("run_query binds typed parameters", async () => {
    const r = await call(ro, "run_query", {
      sql: "SELECT id, name FROM mcp_it WHERE id = ? AND seen_at < ? AND name <> ?",
      params: [100, "2030-01-01T00:00:00Z", { type: "string", value: "2024-01-02" }],
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual((r.structuredContent as { rows: unknown[][] }).rows, [[100, "bound"]]);
    const untyped = await call(ro, "run_query", { sql: "SELECT ?::INTEGER + 1 AS n", params: [41] });
    assert.deepEqual((untyped.structuredContent as { rows: unknown[][] }).rows, [[42]]);
  });

  it("run_query rejects writes, multiple statements and surfaces server errors", async () => {
    const write = await call(ro, "run_query", { sql: "DELETE FROM mcp_it" });
    assert.equal(write.isError, true);
    assert.match(textOf(write), /read-only/);
    const cte = await call(ro, "run_query", { sql: "WITH x AS (SELECT 1) INSERT INTO mcp_it SELECT 1, 'x', 1, NULL" });
    assert.equal(cte.isError, true);
    const multi = await call(ro, "run_query", { sql: "SELECT 1; SELECT 2" });
    assert.equal(multi.isError, true);
    assert.match(textOf(multi), /Only one SQL statement/);
    const bad = await call(ro, "run_query", { sql: "SELECT * FROM no_such_table" });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /no_such_table does not exist/);
    const count = await call(ro, "run_query", { sql: "SELECT count(*) AS n FROM mcp_it" });
    assert.deepEqual((count.structuredContent as { rows: unknown[][] }).rows, [[21]]);
  });

  it("run_query handles unwrappable reads (PRAGMA / SHOW / DESCRIBE)", async () => {
    const pragma = await call(ro, "run_query", { sql: "PRAGMA version" });
    assert.equal(pragma.isError, undefined, textOf(pragma));
    const show = await call(ro, "run_query", { sql: "SHOW TABLES" });
    assert.match(textOf(show), /mcp_it/);
    const describe = await call(ro, "run_query", { sql: "DESCRIBE mcp_it" });
    assert.match(textOf(describe), /amount/);
  });

  it("explain_query returns a plan", async () => {
    const r = await call(ro, "explain_query", { sql: "SELECT count(*) FROM mcp_it;" });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /physical_plan/);
    assert.match(textOf(r), /SEQ_SCAN|UNGROUPED_AGGREGATE/);
  });

  it("times out runaway queries and recovers", async () => {
    const started = Date.now();
    const slow = await call(ro, "run_query", { sql: "SELECT count(*) FROM range(100000000000)" });
    const elapsed = Date.now() - started;
    assert.equal(slow.isError, true);
    assert.match(textOf(slow), /timed out|timeout/i);
    assert.ok(elapsed < 15000, `timeout took ${elapsed}ms`);
    const ok = await call(ro, "run_query", { sql: "SELECT 1 AS ok" });
    assert.equal(ok.isError, undefined, textOf(ok));
  });

  it("serves table DDL as a resource", async () => {
    const listed = await ro.listResources();
    assert.ok(listed.resources.some((r) => r.uri === "gizmosql://schema/memory/main/mcp_it"));
    const read = await ro.readResource({ uri: "gizmosql://schema/memory/main/mcp_it" });
    const text = (read.contents[0] as { text: string }).text;
    assert.match(text, /CREATE TABLE mcp_it/);
  });

  it("serves Streamable HTTP with bearer auth", async () => {
    assert.ok(target);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["dist/cli.js", "--transport", "http", "--port", "0"], {
      env: serverEnv(target, { GIZMOSQL_MCP_BEARER_TOKEN: "test-token" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`http server did not start: ${buf}`)), 20000);
        child.stderr.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /listening on (http:\/\/[^ ]+\/mcp)/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on("exit", (code) => reject(new Error(`server exited (${code}): ${buf}`)));
      });

      const unauthorized = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      });
      assert.equal(unauthorized.status, 401);

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer test-token" } },
      });
      const client = new Client({ name: "http-test", version: "0.0.0" });
      await client.connect(transport);
      const r = await call(client, "run_query", { sql: "SELECT 7 AS seven" });
      assert.deepEqual((r.structuredContent as { rows: unknown[][] }).rows, [[7]]);
      await client.close();
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("applies a default catalog/schema, allows USE in read-only mode, and warns on a bad default", async () => {
    assert.ok(target);
    const withDefault = await stdioClient(target, {
      GIZMOSQL_DEFAULT_CATALOG: "memory",
      GIZMOSQL_DEFAULT_SCHEMA: "main",
    });
    try {
      const info = await call(withDefault, "server_info");
      const s = info.structuredContent as {
        default_catalog: string; default_schema: string; current_catalog: string; current_schema: string; session_warnings: string[];
      };
      assert.equal(s.default_catalog, "memory");
      assert.equal(s.default_schema, "main");
      assert.equal(s.current_catalog, "memory");
      assert.equal(s.current_schema, "main");
      assert.deepEqual(s.session_warnings, []);

      // DuckDB refuses to USE internal catalogs (system/temp), so switch to a user schema.
      await call(rw, "execute_statement", { sql: "CREATE SCHEMA IF NOT EXISTS mcp_alt" });
      const used = await call(withDefault, "use_schema", { catalog: "memory", schema: "mcp_alt" });
      assert.equal(used.isError, undefined, textOf(used));
      assert.deepEqual(used.structuredContent, { catalog: "memory", schema: "mcp_alt" });
      const viaSql = await call(withDefault, "run_query", { sql: "USE memory.main" });
      assert.equal(viaSql.isError, undefined, textOf(viaSql));
      const after = await call(withDefault, "run_query", { sql: "SELECT current_catalog() AS c, current_schema() AS s" });
      assert.deepEqual((after.structuredContent as { rows: unknown[][] }).rows, [["memory", "main"]]);
      const bad = await call(withDefault, "use_schema", { catalog: "no_such_catalog" });
      assert.equal(bad.isError, true);
    } finally {
      await withDefault.close();
    }

    const badDefault = await stdioClient(target, { GIZMOSQL_DEFAULT_CATALOG: "no_such_catalog" });
    try {
      const info = await call(badDefault, "server_info");
      const s = info.structuredContent as { session_warnings: string[]; current_catalog: string };
      assert.equal(s.session_warnings.length, 1);
      assert.match(s.session_warnings[0], /Default catalog\/schema could not be applied/);
      assert.match(s.session_warnings[0], /Available catalogs: .*memory/);
      assert.equal(s.current_catalog, "memory");
    } finally {
      await badDefault.close();
    }
  });

  it("cleans up", async () => {
    const dropped = await call(rw, "execute_statement", { sql: "DROP TABLE mcp_it" });
    assert.equal(dropped.isError, undefined, textOf(dropped));
    await call(rw, "execute_statement", { sql: "DROP SCHEMA IF EXISTS mcp_alt" });
  });
});
