import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { after, before, describe, it } from "node:test";

import { GizmoConnection, parseConfig } from "../../dist/connection.js";
import { httpGetJson, runSsoLogin, type SsoOptions } from "../../dist/sso.js";

/** A TCP port nothing listens on, so a reconnect attempt fails fast. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function connection(port: number): GizmoConnection {
  const cfg = parseConfig({ GIZMOSQL_HOST: "127.0.0.1", GIZMOSQL_PORT: String(port), GIZMOSQL_ENABLE_SSO: "true" });
  return new GizmoConnection(cfg.connections[0], () => {});
}

/** Scripted provider: the initiate response and a queue of poll responses. */
function scripted(initiate: Record<string, unknown>, polls: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const opened: string[] = [];
  let discoveries = 0;
  const options: SsoOptions = {
    waitSeconds: 1,
    pollIntervalMs: 1,
    discover: async () => {
      discoveries++;
      return "https://sso.test/oauth-base";
    },
    getJson: async (url) => {
      calls.push(url);
      if (url.endsWith("/oauth/initiate")) return initiate;
      const next = polls.shift();
      if (!next) throw new Error("no scripted poll response left");
      return next;
    },
    openUrl: async (url) => {
      opened.push(url);
    },
  };
  return { options, calls, opened, discoveries: () => discoveries };
}

const initiateOk = { session_uuid: "sess-1", auth_url: "https://idp.test/authorize?state=abc" };

describe("runSsoLogin", () => {
  let port = 0;
  before(async () => {
    port = await closedPort();
  });

  it("reports unavailable when the server has no OAuth endpoint", async () => {
    const conn = connection(port);
    const r = await runSsoLogin(conn, { waitSeconds: 1, discover: async () => null, getJson: async () => ({}), openUrl: async () => {} });
    assert.equal(r.status, "unavailable");
    assert.match(r.message, /does not expose OAuth\/SSO/);
  });

  it("fails cleanly on a malformed initiate response", async () => {
    const { options } = scripted({ nope: true }, []);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "error");
    assert.match(r.message, /Unexpected response from \/oauth\/initiate/);
  });

  it("opens the browser, polls, and returns pending with the URL when the user has not finished", async () => {
    const { options, opened, calls } = scripted(initiateOk, Array(50).fill({ status: "pending" }));
    const r = await runSsoLogin(connection(port), { ...options, waitSeconds: 0.05 });
    assert.equal(r.status, "pending");
    assert.equal(r.authUrl, initiateOk.auth_url);
    assert.match(r.message, /open this URL: https:\/\/idp\.test\/authorize/);
    assert.deepEqual(opened, [initiateOk.auth_url]);
    assert.equal(calls[0], "https://sso.test/oauth-base/oauth/initiate");
    assert.ok(calls.slice(1).every((u) => u === "https://sso.test/oauth-base/oauth/token/sess-1"));
  });

  it("resumes a pending session on the next call instead of starting a new one", async () => {
    const conn = connection(port);
    const first = scripted(initiateOk, Array(50).fill({ status: "pending" }));
    await runSsoLogin(conn, { ...first.options, waitSeconds: 0.02 });
    const second = scripted({ session_uuid: "would-be-new", auth_url: "https://idp.test/new" }, [{ status: "error", error: "denied" }]);
    const r = await runSsoLogin(conn, second.options);
    assert.equal(second.discoveries(), 0, "no new discovery");
    assert.deepEqual(second.opened, [], "browser not re-opened");
    assert.ok(second.calls.every((u) => u.endsWith("/oauth/token/sess-1")), "polls the original session");
    assert.equal(r.status, "error");
    assert.match(r.message, /OAuth flow failed: denied/);
  });

  it("maps not_found and unexpected poll statuses to errors and forgets the session", async () => {
    const conn = connection(port);
    const nf = scripted(initiateOk, [{ status: "not_found" }]);
    const r1 = await runSsoLogin(conn, nf.options);
    assert.equal(r1.status, "error");
    assert.match(r1.message, /not found/);
    const weird = scripted(initiateOk, [{ status: "bogus" }]);
    const r2 = await runSsoLogin(conn, weird.options);
    assert.equal(weird.discoveries(), 1, "a fresh session is started after the previous one was forgotten");
    assert.equal(r2.status, "error");
    assert.match(r2.message, /Unexpected token poll status: "bogus"/);
  });

  it("rejects a 'complete' poll without a token", async () => {
    const { options } = scripted(initiateOk, [{ status: "complete" }]);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "error");
    assert.match(r.message, /no token/);
  });

  it("switches to the identity token on completion and reports a reconnect failure without leaking it", async () => {
    const conn = connection(port);
    const { options } = scripted(initiateOk, [{ status: "pending" }, { status: "complete", token: "id-token-secret" }]);
    const r = await runSsoLogin(conn, options);
    // Nothing listens on the port, so the reconnect with the new credentials fails.
    assert.equal(r.status, "error");
    assert.match(r.message, /Signed in, but reconnecting with the identity token failed/);
    assert.ok(!r.message.includes("id-token-secret"), "token is redacted from the message");
    assert.deepEqual(conn.effectiveAuth(), { method: "password", user: "token" }, "credentials were switched");
  });
});

describe("httpGetJson", () => {
  let server: http.Server;
  let origin = "";
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
      } else {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html>bad gateway</html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("parses JSON and rejects non-JSON with the status code", async () => {
    assert.deepEqual(await httpGetJson(`${origin}/json`, false), { status: "pending" });
    await assert.rejects(httpGetJson(`${origin}/html`, false), /Unexpected non-JSON response \(HTTP 502\)/);
  });
});
