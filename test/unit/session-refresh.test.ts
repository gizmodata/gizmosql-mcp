// The session settings (USE search path, query timeout) are re-applied
// after an idle gap: GizmoSQL's idle timeout evicts a quiet session and the
// next request on the same bearer token silently gets a fresh one with the
// server's defaults, so nothing on the wire says the search path is gone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tableFromArrays } from "apache-arrow";

import { GizmoConnection, parseConfig } from "../../dist/connection.js";

const base = {
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "svc",
  GIZMOSQL_PASSWORD: "secret",
  GIZMOSQL_DEFAULT_CATALOG: "gizmosql_poc_1",
  GIZMOSQL_DEFAULT_SCHEMA: "vdp_consume",
  GIZMOSQL_QUERY_TIMEOUT_SECONDS: "120",
};

/**
 * What the fake server says to `SELECT name, value FROM gizmosql_settings()`:
 * a map of rows (GizmoSQL 1.38.5+), an empty map (1.38.x before the startup
 * rows), or "error" (a server without gizmosql_settings() at all).
 */
type ServerSettings = Record<string, string> | "error";

/** Records every statement; behaves like a connected client. `failNext` makes the next execute() throw. */
function fakeClient(settings: ServerSettings) {
  const statements: string[] = [];
  let connects = 0;
  const client = {
    failNext: null as Error | null,
    get connects() {
      return connects;
    },
    async connect() {
      connects++;
    },
    async close() {},
    async executeUpdate(sql: string) {
      statements.push(sql);
      return 0;
    },
    async execute(sql: string) {
      if (client.failNext) {
        const err = client.failNext;
        client.failNext = null;
        throw err;
      }
      statements.push(sql);
      if (/gizmosql_settings\(\)/u.test(sql)) {
        if (settings === "error") throw new Error("Catalog Error: Table Function with name gizmosql_settings does not exist!");
        return tableFromArrays({ name: Object.keys(settings), value: Object.values(settings) });
      }
      return tableFromArrays({ x: [1] });
    },
    async getCatalogs() {
      return ["gizmosql_poc_1"];
    },
  };
  return { statements, client };
}

function connection(env: Record<string, string>, settings: ServerSettings = {}) {
  const cfg = parseConfig({ ...base, ...env });
  const { statements, client } = fakeClient(settings);
  let clock = 1_000_000;
  const logs: string[] = [];
  const conn = new GizmoConnection(cfg.connections[0], (m) => logs.push(m), {
    createClient: () => client as never,
    now: () => clock,
  });
  return { conn, client, statements, logs, advance: (seconds: number) => (clock += seconds * 1000) };
}

const SETUP = ['SET gizmosql.query_timeout = 120', 'USE "gizmosql_poc_1"."vdp_consume"'];
/** Statements a fresh connection issues: setup, then the settings probe. */
const OPEN = SETUP.length + 1;

/** Everything after the connection-open statements. */
const after = (statements: string[], n = OPEN) => statements.slice(n);

describe("session refresh after idle", () => {
  it("applies the settings on connect, probes the server settings, and leaves a busy session alone", async () => {
    const { conn, statements, advance } = connection({});
    await conn.run((c) => c.execute("SELECT 1"));
    assert.deepEqual(statements.slice(0, 2), SETUP);
    assert.match(statements[2], /^SELECT name, value FROM gizmosql_settings\(\) WHERE name IN \('gizmosql\.version'/u);
    assert.deepEqual(after(statements), ["SELECT 1"]);
    advance(59);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.deepEqual(after(statements, OPEN + 1), ["SELECT 2"], "no refresh under the threshold");
    assert.equal(conn.sessionRefreshes, 0);
  });

  it("re-applies the search path and timeout before the first statement after the idle threshold", async () => {
    const { conn, statements, logs, advance } = connection({});
    await conn.run((c) => c.execute("SELECT 1"));
    advance(61);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.deepEqual(after(statements, OPEN + 1), [...SETUP, "SELECT 2"]);
    assert.equal(conn.sessionRefreshes, 1);
    assert.ok(logs.some((l) => /session settings re-applied after 61s idle/u.test(l)), logs.join("\n"));
    // Idle is measured from the end of the last statement, so the next call is quiet again.
    await conn.run((c) => c.execute("SELECT 3"));
    assert.deepEqual(statements.slice(-1), ["SELECT 3"]);
  });

  it("derives the threshold from the server's session_idle_timeout when it reports one (GizmoSQL 1.38.5+)", async () => {
    const { conn, logs, advance } = connection({}, {
      "gizmosql.version": "v1.38.5",
      "gizmosql.edition": "Enterprise",
      "gizmosql.session_idle_timeout": "100",
      "gizmosql.max_sessions": "0",
    });
    await conn.run((c) => c.execute("SELECT 1"));
    assert.equal(conn.sessionRefreshThresholdSeconds(), 90, "ten percent under the server's eviction point");
    assert.ok(logs.some((l) => /session refresh after 90s idle \(server session_idle_timeout 100; GizmoSQL v1.38.5 Enterprise\)/u.test(l)), logs.join("\n"));
    advance(61);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.equal(conn.sessionRefreshes, 0, "61s is quiet for a server that evicts at 100s");
    advance(91);
    await conn.run((c) => c.execute("SELECT 3"));
    assert.equal(conn.sessionRefreshes, 1);
    assert.deepEqual(conn.serverSettingsSnapshot()["gizmosql.session_idle_timeout"], "100");
  });

  it("never refreshes when the server reports that idle eviction is off", async () => {
    const { conn, statements, advance } = connection({}, { "gizmosql.session_idle_timeout": "0" });
    await conn.run((c) => c.execute("SELECT 1"));
    assert.equal(conn.sessionRefreshThresholdSeconds(), 0);
    advance(86400);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.equal(conn.sessionRefreshes, 0);
    assert.deepEqual(statements.slice(-1), ["SELECT 2"]);
  });

  it("falls back to the default when the server has gizmosql_settings() without the startup rows, or no gizmosql_settings() at all", async () => {
    for (const settings of [{}, "error"] as const) {
      const { conn, logs, advance } = connection({}, settings);
      await conn.run((c) => c.execute("SELECT 1"));
      assert.equal(conn.sessionRefreshThresholdSeconds(), 60);
      advance(61);
      await conn.run((c) => c.execute("SELECT 2"));
      assert.equal(conn.sessionRefreshes, 1);
      assert.ok(logs.some((l) => /session refresh after 60s idle \(server session_idle_timeout not reported\)/u.test(l)), logs.join("\n"));
      if (settings === "error") {
        assert.ok(logs.some((l) => /server settings unavailable \(older GizmoSQL\?\)/u.test(l)), logs.join("\n"));
        assert.deepEqual(conn.serverSettingsSnapshot(), {});
      }
    }
  });

  it("reconnects transparently when the server says the session is gone (restart, eviction, kill)", async () => {
    const { conn, client, statements, logs } = connection({}, { "gizmosql.session_idle_timeout": "0" });
    await conn.run((c) => c.execute("SELECT 1"));
    assert.equal(client.connects, 1);
    // The server was restarted: the bearer token names the old instance.
    client.failNext = Object.assign(
      new Error("Session not associated with this server instance (158f0bd2-1111-2222-3333-444444444444). Please reconnect to establish a new session"),
      { name: "AuthenticationError" },
    );
    const before = statements.length;
    await conn.run((c) => c.execute("SELECT 2"));
    assert.equal(client.connects, 2, "a fresh handshake");
    // Reconnect re-applies the session settings and re-probes before retrying the statement.
    assert.deepEqual(statements.slice(before, before + 2), SETUP);
    assert.match(statements[before + 2], /gizmosql_settings\(\)/u);
    assert.deepEqual(statements.slice(-1), ["SELECT 2"]);
    assert.ok(logs.some((l) => /session lost \(server restarted, or session evicted\/killed\), reconnecting: Session not associated/u.test(l)), logs.join("\n"));

    // A genuine credentials failure is not retried into a loop: it surfaces.
    client.failNext = Object.assign(new Error("Invalid credentials"), { name: "AuthenticationError" });
    await assert.rejects(conn.run((c) => c.execute("SELECT 3")), /Invalid credentials/u);
    assert.equal(client.connects, 2);
  });

  it("lets an explicit GIZMOSQL_SESSION_REFRESH_SECONDS override what the server reports", async () => {
    const { conn, advance } = connection({ GIZMOSQL_SESSION_REFRESH_SECONDS: "10" }, { "gizmosql.session_idle_timeout": "1000" });
    await conn.run((c) => c.execute("SELECT 1"));
    assert.equal(conn.sessionRefreshThresholdSeconds(), 10);
    advance(11);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.equal(conn.sessionRefreshes, 1);
  });

  it("honours GIZMOSQL_SESSION_REFRESH_SECONDS, including 0 to disable", async () => {
    const short = connection({ GIZMOSQL_SESSION_REFRESH_SECONDS: "5" });
    await short.conn.run((c) => c.execute("SELECT 1"));
    short.advance(6);
    await short.conn.run((c) => c.execute("SELECT 2"));
    assert.equal(short.conn.sessionRefreshes, 1);

    const off = connection({ GIZMOSQL_SESSION_REFRESH_SECONDS: "0" });
    await off.conn.run((c) => c.execute("SELECT 1"));
    off.advance(86400);
    await off.conn.run((c) => c.execute("SELECT 2"));
    assert.equal(off.conn.sessionRefreshes, 0);
    assert.deepEqual(off.statements.slice(-1), ["SELECT 2"]);
  });

  it("follows use_schema: the refreshed search path is the current one, not the configured default", async () => {
    const { conn, statements, advance } = connection({});
    await conn.run((c) => c.execute("SELECT 1"));
    await conn.useSchema({ catalog: "gizmosql_poc_1", schema: "other" });
    advance(120);
    await conn.run((c) => c.execute("SELECT 2"));
    const tail = statements.slice(-3);
    assert.deepEqual(tail, ['SET gizmosql.query_timeout = 120', 'USE "gizmosql_poc_1"."other"', "SELECT 2"]);
  });
});
