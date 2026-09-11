import assert from "node:assert/strict";
import * as http from "node:http";
import { after, before, describe, it } from "node:test";

import { ConfigError, parseConfig } from "../../dist/connection.js";
import {
  OAuthVerifier,
  discoveryUrls,
  emailMatches,
  protectedResourceMetadataPaths,
  protectedResourceMetadataUrl,
  userFromClaims,
} from "../../dist/oauth.js";
import { facadeIssuer, facadeMetadataPaths, refreshScope } from "../../dist/oauth-facade.js";
import { startHttp } from "../../dist/transports.js";
import { FakeIssuer } from "../helpers/fake-issuer.ts";

const base = {
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "svc",
  GIZMOSQL_PASSWORD: "secret",
};

describe("oauth helpers", () => {
  it("derives the protected-resource metadata paths from the public URL", () => {
    assert.deepEqual(protectedResourceMetadataPaths("https://mcp.example.com/mcp"), [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]);
    assert.deepEqual(protectedResourceMetadataPaths("https://mcp.example.com"), ["/.well-known/oauth-protected-resource"]);
    assert.equal(
      protectedResourceMetadataUrl("https://mcp.example.com/mcp"),
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("tries OpenID Connect discovery before RFC 8414, honouring issuer paths", () => {
    assert.deepEqual(discoveryUrls("https://login.microsoftonline.com/tenant-id/v2.0"), [
      "https://login.microsoftonline.com/tenant-id/v2.0/.well-known/openid-configuration",
      "https://login.microsoftonline.com/.well-known/oauth-authorization-server/tenant-id/v2.0",
      "https://login.microsoftonline.com/tenant-id/v2.0/.well-known/oauth-authorization-server",
    ]);
    assert.deepEqual(discoveryUrls("https://clerk.example.com/"), [
      "https://clerk.example.com/.well-known/openid-configuration",
      "https://clerk.example.com/.well-known/oauth-authorization-server",
    ]);
  });

  it("matches email globs case-insensitively", () => {
    assert.ok(emailMatches("Alice@DanVaden.com", "*@danvaden.com"));
    assert.ok(emailMatches("alice@danvaden.com", "alice@danvaden.com"));
    assert.ok(!emailMatches("alice@danvaden.com.evil.io", "*@danvaden.com"));
    assert.ok(!emailMatches("alice@example.com", "*@danvaden.com"));
    assert.ok(emailMatches("a.b+c@x.io", "a.b+c@x.io"));
  });

  it("names the user from the first configured claim and finds an email", () => {
    const u = userFromClaims({ sub: "abc", preferred_username: "alice@x.io", name: "Alice" }, ["email", "preferred_username", "sub"]);
    assert.equal(u.name, "alice@x.io");
    assert.equal(u.email, "alice@x.io");
    assert.equal(u.subject, "abc");
    const noEmail = userFromClaims({ sub: "abc", name: "svc" }, ["email", "name"]);
    assert.equal(noEmail.name, "svc");
    assert.equal(noEmail.email, undefined);
  });
});

describe("parseConfig (OAuth)", () => {
  it("is off unless the issuer is set", () => {
    assert.equal(parseConfig({ ...base }).mcpOAuth, undefined);
  });

  it("requires the public URL and defaults the audience to it", () => {
    assert.throws(
      () => parseConfig({ ...base, GIZMOSQL_MCP_OAUTH_ISSUER: "https://idp.example.com" }),
      (e: unknown) => e instanceof ConfigError && /GIZMOSQL_MCP_PUBLIC_URL/.test(e.message),
    );
    const cfg = parseConfig({
      ...base,
      GIZMOSQL_MCP_OAUTH_ISSUER: "https://idp.example.com/",
      GIZMOSQL_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
    });
    assert.deepEqual(cfg.mcpOAuth, {
      publicUrl: "https://mcp.example.com/mcp",
      issuer: "https://idp.example.com",
      audiences: ["https://mcp.example.com/mcp"],
      jwksUri: undefined,
      scopes: [],
      userClaims: ["email", "preferred_username", "upn", "name", "sub"],
      authorizedEmails: [],
      tokenProxy: false,
    });
  });

  it("parses lists and rejects insecure URLs unless allowed", () => {
    const cfg = parseConfig({
      ...base,
      GIZMOSQL_MCP_OAUTH_ISSUER: "https://login.microsoftonline.com/t/v2.0",
      GIZMOSQL_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
      GIZMOSQL_MCP_OAUTH_AUDIENCE: "client-id, https://mcp.example.com/mcp",
      GIZMOSQL_MCP_OAUTH_SCOPES: "https://mcp.example.com/mcp/access_as_user offline_access",
      GIZMOSQL_MCP_OAUTH_AUTHORIZED_EMAILS: "*@danvaden.com,bob@example.com",
      GIZMOSQL_MCP_OAUTH_USER_CLAIM: "upn",
    });
    assert.deepEqual(cfg.mcpOAuth?.audiences, ["client-id", "https://mcp.example.com/mcp"]);
    assert.deepEqual(cfg.mcpOAuth?.scopes, ["https://mcp.example.com/mcp/access_as_user", "offline_access"]);
    assert.deepEqual(cfg.mcpOAuth?.authorizedEmails, ["*@danvaden.com", "bob@example.com"]);
    assert.deepEqual(cfg.mcpOAuth?.userClaims, ["upn"]);

    assert.throws(
      () => parseConfig({ ...base, GIZMOSQL_MCP_OAUTH_ISSUER: "http://idp.local", GIZMOSQL_MCP_PUBLIC_URL: "https://m/mcp" }),
      (e: unknown) => e instanceof ConfigError && /https/.test(e.message),
    );
    const insecure = parseConfig({
      ...base,
      GIZMOSQL_MCP_OAUTH_ISSUER: "http://idp.local",
      GIZMOSQL_MCP_PUBLIC_URL: "http://localhost:3000/mcp",
      GIZMOSQL_MCP_OAUTH_ALLOW_INSECURE: "true",
    });
    assert.equal(insecure.mcpOAuth?.issuer, "http://idp.local");
  });

  it("refuses OAuth settings without an issuer, and OAuth combined with a static bearer token", () => {
    assert.throws(
      () => parseConfig({ ...base, GIZMOSQL_MCP_OAUTH_AUDIENCE: "x" }),
      (e: unknown) => e instanceof ConfigError && /GIZMOSQL_MCP_OAUTH_ISSUER is not/.test(e.message),
    );
    assert.throws(
      () =>
        parseConfig({
          ...base,
          GIZMOSQL_MCP_OAUTH_ISSUER: "https://idp.example.com",
          GIZMOSQL_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
          GIZMOSQL_MCP_BEARER_TOKEN: "static",
        }),
      (e: unknown) => e instanceof ConfigError && /mutually exclusive/.test(e.message),
    );
  });
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

describe("Streamable HTTP with OAuth", () => {
  const idp = new FakeIssuer();
  let server: http.Server;
  let origin = "";
  const publicUrl = "https://mcp.example.com/mcp";

  const post = (token?: string, body: unknown = initialize) =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  before(async () => {
    await idp.start();
    const config = parseConfig({
      ...base,
      GIZMOSQL_2_HOST: "db2.internal",
      GIZMOSQL_2_USERNAME: "svc",
      GIZMOSQL_2_PASSWORD: "secret",
      GIZMOSQL_ENABLE_SSO: "true",
      GIZMOSQL_MCP_OAUTH_ISSUER: idp.issuer,
      GIZMOSQL_MCP_PUBLIC_URL: publicUrl,
      GIZMOSQL_MCP_OAUTH_AUDIENCE: "api://gizmosql-mcp, client-id-guid",
      GIZMOSQL_MCP_OAUTH_SCOPES: "api://gizmosql-mcp/access_as_user",
      GIZMOSQL_MCP_OAUTH_AUTHORIZED_EMAILS: "*@danvaden.com",
      GIZMOSQL_MCP_OAUTH_ALLOW_INSECURE: "true",
    });
    server = await startHttp(config, { host: "127.0.0.1", port: 0, installSignalHandlers: false });
    const addr = server.address() as { port: number };
    origin = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await idp.stop();
  });

  it("serves the protected-resource metadata at both well-known paths", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${origin}${path}`);
      assert.equal(res.status, 200, path);
      const doc = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(doc, {
        resource: publicUrl,
        authorization_servers: [idp.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["api://gizmosql-mcp/access_as_user"],
      });
    }
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  });

  it("answers 401 with a WWW-Authenticate challenge when the token is missing", async () => {
    const res = await post();
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer error="invalid_token"/);
    assert.match(challenge, /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(challenge, /scope="api:\/\/gizmosql-mcp\/access_as_user"/);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_token");
  });

  it("rejects tokens with the wrong audience, issuer, or signature, and expired ones", async () => {
    const cases: Array<[string, Promise<string>]> = [
      ["audience", idp.token({ sub: "u1", email: "a@danvaden.com" }, { audience: "someone-else" })],
      ["issuer", idp.token({ sub: "u1", email: "a@danvaden.com" }, { issuer: "https://evil.example.com" })],
      ["expiry", idp.token({ sub: "u1", email: "a@danvaden.com" }, { expiresIn: "-10m" })],
    ];
    for (const [label, tokenPromise] of cases) {
      const res = await post(await tokenPromise);
      assert.equal(res.status, 401, label);
      assert.match(res.headers.get("www-authenticate") ?? "", /invalid_token/, label);
    }
    const other = new FakeIssuer();
    await other.start();
    try {
      const forged = await other.token({ sub: "u1", email: "a@danvaden.com" }, { issuer: idp.issuer });
      assert.equal((await post(forged)).status, 401, "signature");
    } finally {
      await other.stop();
    }
  });

  it("answers 403 without a challenge for a valid token outside the email allowlist", async () => {
    const res = await post(await idp.token({ sub: "u2", email: "mallory@example.com" }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("www-authenticate"), null);
    const body = (await res.json()) as { error: string; error_description: string };
    assert.equal(body.error, "forbidden");
    assert.match(body.error_description, /mallory@example.com/);
  });

  it("serves the MCP endpoint for a valid token and accepts any configured audience", async () => {
    for (const audience of ["api://gizmosql-mcp", "client-id-guid"]) {
      const res = await post(await idp.token({ sub: "u3", preferred_username: "Chris@DanVaden.com" }, { audience }));
      assert.equal(res.status, 200, audience);
      const text = await res.text();
      assert.match(text, /"serverInfo"/);
    }
    assert.equal(idp.discoveryHits, 1, "discovery is cached after the first token");
  });

  /** Runs one JSON-RPC request through the stateless transport and returns the result object. */
  const rpc = async (token: string, method: string, params: Record<string, unknown> = {}, id = 1) => {
    const res = await post(token, { jsonrpc: "2.0", id, method, params });
    assert.equal(res.status, 200, method);
    const text = await res.text();
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)))
      .find((m) => m.id === id);
    assert.ok(data, `no response for ${method}: ${text}`);
    return data.result as Record<string, any>;
  };

  it("keeps session state (use_connection) private to each user", async () => {
    const alice = await idp.token({ sub: "alice-oid", email: "alice@danvaden.com" });
    const bob = await idp.token({ sub: "bob-oid", email: "bob@danvaden.com" });
    const current = async (token: string) => {
      const r = await rpc(token, "tools/call", { name: "list_connections", arguments: {} });
      return (r.structuredContent as { current: string }).current;
    };
    assert.equal(await current(alice), "default");
    assert.equal(await current(bob), "default");

    const switched = await rpc(alice, "tools/call", { name: "use_connection", arguments: { name: "server2" } });
    assert.equal((switched.structuredContent as { current: string }).current, "server2");

    assert.equal(await current(alice), "server2", "alice's next request sees her switch");
    assert.equal(await current(bob), "default", "bob is unaffected");

    // A fresh token for the same subject lands in the same session.
    const aliceAgain = await idp.token({ sub: "alice-oid", email: "alice@danvaden.com" });
    assert.equal(await current(aliceAgain), "server2");
  });

  it("does not offer login_sso over HTTP even when SSO is enabled", async () => {
    const r = await rpc(await idp.token({ sub: "x", email: "x@danvaden.com" }), "tools/list");
    const names = (r.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes("use_schema"));
    assert.ok(names.includes("use_connection"));
    assert.ok(!names.includes("login_sso"), names.join(","));
  });

  it("keeps a direct verifier usable for unit tests", async () => {
    const verifier = new OAuthVerifier(
      {
        publicUrl,
        issuer: idp.issuer,
        audiences: ["api://gizmosql-mcp"],
        scopes: [],
        userClaims: ["email"],
        authorizedEmails: [],
      },
      { log: () => {} },
    );
    const user = await verifier.verify(`Bearer ${await idp.token({ sub: "u4", email: "d@danvaden.com" })}`);
    assert.equal(user.name, "d@danvaden.com");
    assert.equal(verifier.challenge(), `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe("oauth token-proxy facade", () => {
  const idp = new FakeIssuer();
  const publicUrl = "https://mcp.example.com/mcp";
  const apiScope = "https://mcp.example.com/mcp/access_as_user";
  let server: http.Server;
  let origin = "";
  const lines: string[] = [];
  const originalError = console.error;

  before(async () => {
    await idp.start();
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    const config = parseConfig({
      ...base,
      GIZMOSQL_MCP_OAUTH_ISSUER: idp.issuer,
      GIZMOSQL_MCP_PUBLIC_URL: publicUrl,
      GIZMOSQL_MCP_OAUTH_AUDIENCE: "client-id-guid",
      GIZMOSQL_MCP_OAUTH_SCOPES: `${apiScope} openid profile email offline_access`,
      GIZMOSQL_MCP_OAUTH_TOKEN_PROXY: "true",
      GIZMOSQL_MCP_OAUTH_ALLOW_INSECURE: "true",
    });
    server = await startHttp(config, { host: "127.0.0.1", port: 0, installSignalHandlers: false });
    const addr = server.address() as { port: number };
    origin = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    console.error = originalError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await idp.stop();
  });

  const token = (body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });

  it("merges the API scope and offline_access into a refresh that names no resource", () => {
    assert.deepEqual(refreshScope("openid profile offline_access", [apiScope, "openid", "offline_access"]), {
      scope: `openid profile offline_access ${apiScope}`,
      injected: true,
    });
    assert.deepEqual(refreshScope(null, [apiScope]), { scope: `${apiScope} offline_access`, injected: true });
    assert.deepEqual(refreshScope(`${apiScope} offline_access`, [apiScope]), { scope: `${apiScope} offline_access`, injected: false });
  });

  it("points the protected-resource metadata at the facade and serves the rewritten provider document", async () => {
    const facade = facadeIssuer(publicUrl);
    assert.equal(facade, "https://mcp.example.com/oauth");
    const prm = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as { authorization_servers: string[] };
    assert.deepEqual(prm.authorization_servers, [facade]);
    for (const path of facadeMetadataPaths()) {
      const res = await fetch(`${origin}${path}`);
      assert.equal(res.status, 200, path);
      const doc = (await res.json()) as Record<string, unknown>;
      assert.equal(doc.issuer, facade, path);
      assert.equal(doc.token_endpoint, `${facade}/token`, path);
      assert.equal(doc.authorization_endpoint, `${idp.issuer}/authorize`, path);
      assert.equal(doc.jwks_uri, idp.jwksUri, path);
      assert.deepEqual(doc.code_challenge_methods_supported, ["S256"], path);
    }
    assert.ok(lines.some((l) => l.includes(`via token proxy ${facade}`)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("AADSTS90009")), lines.join("\n"));
  });

  it("passes authorization_code exchanges through untouched, credentials included", async () => {
    idp.tokenRequests.length = 0;
    const res = await token(
      { grant_type: "authorization_code", code: "c1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: "client-id-guid", code_verifier: "v", resource: publicUrl },
      { authorization: "Basic Y2xpZW50OnNlY3JldA==" },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string; refresh_token?: string };
    assert.equal(body.refresh_token, "fake-refresh-secret");
    assert.equal(idp.tokenRequests.length, 1);
    const seen = idp.tokenRequests[0];
    assert.equal(seen.params.get("scope"), null);
    assert.equal(seen.params.get("code_verifier"), "v");
    assert.equal(seen.params.get("resource"), publicUrl);
    assert.equal(seen.authorization, "Basic Y2xpZW50OnNlY3JldA==");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("makes a Claude-style refresh succeed by adding the API scope, and logs no secrets", async () => {
    idp.tokenRequests.length = 0;
    // Entra would refuse this request as sent (no resource scope) with AADSTS90009.
    const res = await token({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-secret",
      client_id: "client-id-guid",
      client_secret: "client-secret-value",
      scope: "openid profile offline_access",
      resource: publicUrl,
    });
    const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.refresh_token, "fake-refresh-secret");
    assert.equal(body.expires_in, 3599);
    const seen = idp.tokenRequests[0];
    assert.equal(seen.params.get("scope"), `openid profile offline_access ${apiScope}`);
    assert.equal(seen.params.get("refresh_token"), "fake-refresh-secret");
    assert.equal(seen.params.get("client_secret"), "client-secret-value");
    const line = lines.find((l) => l.includes("refresh_token (scope added)"));
    assert.ok(line, lines.join("\n"));
    assert.match(line, /HTTP 200 \(refresh_token yes, expires_in 3599s\)/u);
    for (const l of lines) {
      assert.ok(!l.includes("fake-refresh-secret") && !l.includes("client-secret-value") && !l.includes(body.access_token), l);
    }
  });

  it("relays the provider's error, one line, when a refresh still fails", async () => {
    // A resource scope for some other API: passed through as-is; the fake
    // provider accepts it, so force a failure with an unsupported grant.
    const res = await token({ grant_type: "password", username: "u", password: "p" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "unsupported_grant_type" });
    assert.ok(lines.some((l) => /password -> HTTP 400 unsupported_grant_type$/u.test(l)), lines.join("\n"));
    assert.equal((await fetch(`${origin}/oauth/token`)).status, 405);
    const wrongType = await fetch(`${origin}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(wrongType.status, 415);
  });

  it("without the proxy, warns when the issuer is Entra", async () => {
    const before = lines.length;
    const config = parseConfig({
      ...base,
      GIZMOSQL_MCP_OAUTH_ISSUER: "http://login.microsoftonline.com/tenant/v2.0",
      GIZMOSQL_MCP_PUBLIC_URL: publicUrl,
      GIZMOSQL_MCP_OAUTH_SCOPES: `${apiScope} offline_access`,
      GIZMOSQL_MCP_OAUTH_JWKS_URI: idp.jwksUri,
      GIZMOSQL_MCP_OAUTH_ALLOW_INSECURE: "true",
    });
    const plain = await startHttp(config, { host: "127.0.0.1", port: 0, installSignalHandlers: false });
    try {
      assert.ok(lines.slice(before).some((l) => l.includes("AADSTS90009") && l.includes("GIZMOSQL_MCP_OAUTH_TOKEN_PROXY=true")), lines.slice(before).join("\n"));
      const port = (plain.address() as { port: number }).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST" })).status, 404);
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });
});
