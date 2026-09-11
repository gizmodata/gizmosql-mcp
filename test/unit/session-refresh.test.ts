// The session settings (USE search path, query timeout) are re-applied
// after an idle gap: GizmoSQL's idle timeout evicts a quiet session and the
// next request on the same bearer token silently gets a fresh one with the
// server's defaults, so nothing on the wire says the search path is gone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GizmoConnection, parseConfig } from "../../dist/connection.js";

const base = {
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "svc",
  GIZMOSQL_PASSWORD: "secret",
  GIZMOSQL_DEFAULT_CATALOG: "gizmosql_poc_1",
  GIZMOSQL_DEFAULT_SCHEMA: "vdp_consume",
  GIZMOSQL_QUERY_TIMEOUT_SECONDS: "120",
};

/** Records every statement; behaves like a connected client. */
function fakeClient() {
  const statements: string[] = [];
  const client = {
    async connect() {},
    async close() {},
    async executeUpdate(sql: string) {
      statements.push(sql);
      return 0;
    },
    async execute(sql: string) {
      statements.push(sql);
      return { rows: [] };
    },
    async getCatalogs() {
      return ["gizmosql_poc_1"];
    },
  };
  return { statements, client };
}

function connection(env: Record<string, string>) {
  const cfg = parseConfig({ ...base, ...env });
  const { statements, client } = fakeClient();
  let clock = 1_000_000;
  const logs: string[] = [];
  const conn = new GizmoConnection(cfg.connections[0], (m) => logs.push(m), {
    createClient: () => client as never,
    now: () => clock,
  });
  return { conn, statements, logs, advance: (seconds: number) => (clock += seconds * 1000) };
}

const SETUP = ['SET gizmosql.query_timeout = 120', 'USE "gizmosql_poc_1"."vdp_consume"'];

describe("session refresh after idle", () => {
  it("applies the settings on connect and leaves a busy session alone", async () => {
    const { conn, statements, advance } = connection({});
    await conn.run((c) => c.execute("SELECT 1"));
    assert.deepEqual(statements, [...SETUP, "SELECT 1"]);
    advance(59);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.deepEqual(statements.slice(3), ["SELECT 2"], "no refresh under the threshold");
    assert.equal(conn.sessionRefreshes, 0);
  });

  it("re-applies the search path and timeout before the first statement after the idle threshold", async () => {
    const { conn, statements, logs, advance } = connection({});
    await conn.run((c) => c.execute("SELECT 1"));
    advance(61);
    await conn.run((c) => c.execute("SELECT 2"));
    assert.deepEqual(statements.slice(3), [...SETUP, "SELECT 2"]);
    assert.equal(conn.sessionRefreshes, 1);
    assert.ok(logs.some((l) => /session settings re-applied after 61s idle/u.test(l)), logs.join("\n"));
    // Idle is measured from the end of the last statement, so the next call is quiet again.
    await conn.run((c) => c.execute("SELECT 3"));
    assert.deepEqual(statements.slice(6), ["SELECT 3"]);
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
    assert.deepEqual(off.statements.slice(3), ["SELECT 2"]);
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
