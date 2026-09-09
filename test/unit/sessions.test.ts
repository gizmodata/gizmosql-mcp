import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../../dist/connection.js";
import { SessionStore } from "../../dist/sessions.js";

const config = parseConfig({
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "svc",
  GIZMOSQL_PASSWORD: "secret",
  GIZMOSQL_2_HOST: "db2.internal",
  GIZMOSQL_2_USERNAME: "svc",
  GIZMOSQL_2_PASSWORD: "secret",
});

function store(opts: { idleSeconds?: number; maxSessions?: number } = {}) {
  let now = 1_000_000;
  const lines: string[] = [];
  const s = new SessionStore(config, {
    idleSeconds: opts.idleSeconds ?? 60,
    maxSessions: opts.maxSessions ?? 10,
    log: (m) => lines.push(m),
    now: () => now,
    sweepIntervalMs: 0,
  });
  return { s, lines, tick: (ms: number) => (now += ms) };
}

describe("SessionStore", () => {
  it("gives each key its own registry and keeps it between requests", () => {
    const { s, lines } = store();
    const a1 = s.acquire("issuer#alice", "alice@x.io");
    const b1 = s.acquire("issuer#bob", "bob@x.io");
    const a2 = s.acquire("issuer#alice", "alice@x.io");
    assert.equal(a1.registry, a2.registry);
    assert.notEqual(a1.registry, b1.registry);
    assert.equal(s.size(), 2);

    a1.registry.use("server2");
    assert.equal(a2.registry.current(), "server2");
    assert.equal(b1.registry.current(), "default", "bob's default is untouched");
    assert.equal(lines.filter((l) => /session opened/.test(l)).length, 2);
  });

  it("closes idle sessions on sweep and re-creates them on the next request", async () => {
    const { s, tick, lines } = store({ idleSeconds: 60 });
    const first = s.acquire("k", "alice");
    first.registry.use("server2");
    tick(30_000);
    s.acquire("k", "alice"); // refreshes lastUsedAt
    tick(45_000);
    await s.sweep();
    assert.equal(s.size(), 1, "used 45s ago, still within 60s");
    tick(20_000);
    await s.sweep();
    assert.equal(s.size(), 0, "65s idle: evicted");
    assert.match(lines.at(-1) ?? "", /session closed for alice \(idle/);
    const fresh = s.acquire("k", "alice");
    assert.notEqual(fresh.registry, first.registry);
    assert.equal(fresh.registry.current(), "default", "state does not survive eviction");
  });

  it("evicts the least recently used session when the pool is full", () => {
    const { s, tick, lines } = store({ maxSessions: 2 });
    s.acquire("a", "a");
    tick(1000);
    s.acquire("b", "b");
    tick(1000);
    s.acquire("a", "a"); // a is now the most recently used
    tick(1000);
    s.acquire("c", "c"); // pool full: b goes
    assert.equal(s.size(), 2);
    assert.deepEqual(s.sessions().map((x) => x.key), ["a", "c"]);
    assert.match(lines.find((l) => /session closed for b/.test(l)) ?? "", /pool full/);
  });

  it("tells the next request once that a closed session was replaced", async () => {
    const { s, tick } = store({ idleSeconds: 60 });
    s.acquire("k", "alice");
    tick(61_000);
    await s.sweep();
    const reopened = s.acquire("k", "alice");
    assert.ok(reopened.info.resetAt instanceof Date, "resetAt set on the replacement session");
    assert.equal(reopened.info.resetAt.getTime(), 1_000_000 + 61_000, "resetAt is when the old session was closed");
    assert.ok(s.acquire("k", "alice").info.resetAt, "still pending until acknowledged");
    s.acknowledgeReset("k");
    assert.equal(s.acquire("k", "alice").info.resetAt, undefined);
    assert.equal(s.acquire("new", "bob").info.resetAt, undefined, "a first-ever session has nothing to report");
  });

  it("refuses new sessions after close", async () => {
    const { s } = store();
    s.acquire("a", "a");
    await s.close();
    assert.equal(s.size(), 0);
    assert.throws(() => s.acquire("a", "a"), /closed/);
  });
});
