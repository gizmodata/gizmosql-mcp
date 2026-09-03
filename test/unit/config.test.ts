import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigError,
  DEFAULTS,
  GizmoConnection,
  isConnectionError,
  parseBoolean,
  parseConfig,
  redactSecrets,
  redactedUri,
} from "../../dist/connection.js";

const base = {
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "alice",
  GIZMOSQL_PASSWORD: "p@ss word",
};

describe("parseConfig", () => {
  it("applies defaults", () => {
    const c = parseConfig({ ...base });
    assert.equal(c.host, "db.internal");
    assert.equal(c.port, DEFAULTS.port);
    assert.equal(c.username, "alice");
    assert.equal(c.password, "p@ss word");
    assert.equal(c.token, undefined);
    assert.equal(c.plaintext, false);
    assert.equal(c.tlsSkipVerify, false);
    assert.equal(c.oauthPort, DEFAULTS.oauthPort);
    assert.equal(c.allowWrites, false);
    assert.equal(c.maxRows, DEFAULTS.maxRows);
    assert.equal(c.maxCellChars, DEFAULTS.maxCellChars);
    assert.equal(c.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    assert.equal(c.mcpBearerToken, undefined);
    assert.equal(c.enableSso, false);
  });

  it("parses overrides", () => {
    const c = parseConfig({
      GIZMOSQL_HOST: "h",
      GIZMOSQL_PORT: "31338",
      GIZMOSQL_TOKEN: "tok",
      GIZMOSQL_PLAINTEXT: "true",
      GIZMOSQL_TLS_SKIP_VERIFY: "1",
      GIZMOSQL_ALLOW_WRITES: "yes",
      GIZMOSQL_MAX_ROWS: "10",
      GIZMOSQL_MAX_CELL_CHARS: "50",
      GIZMOSQL_QUERY_TIMEOUT_SECONDS: "0",
      GIZMOSQL_OAUTH_PORT: "1234",
      GIZMOSQL_MCP_BEARER_TOKEN: "bearer",
    });
    assert.equal(c.port, 31338);
    assert.equal(c.token, "tok");
    assert.equal(c.username, undefined);
    assert.equal(c.plaintext, true);
    assert.equal(c.tlsSkipVerify, true);
    assert.equal(c.allowWrites, true);
    assert.equal(c.maxRows, 10);
    assert.equal(c.maxCellChars, 50);
    assert.equal(c.queryTimeoutSeconds, 0);
    assert.equal(c.oauthPort, 1234);
    assert.equal(c.mcpBearerToken, "bearer");
  });

  it("requires a host and exactly one auth method", () => {
    assert.throws(() => parseConfig({}), /GIZMOSQL_HOST is required/);
    assert.throws(() => parseConfig({ GIZMOSQL_HOST: "h" }), /No credentials configured/);
    assert.throws(
      () => parseConfig({ ...base, GIZMOSQL_TOKEN: "t" }),
      /not both/,
    );
    assert.throws(
      () => parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_USERNAME: "u" }),
      /must be set together/,
    );
    assert.throws(
      () => parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_PASSWORD: "p" }),
      /must be set together/,
    );
  });

  it("allows an empty password when the username is set", () => {
    const c = parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_USERNAME: "u", GIZMOSQL_PASSWORD: "" });
    assert.equal(c.username, "u");
    assert.equal(c.password, "");
  });

  it("allows no credentials when SSO is enabled", () => {
    const c = parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_ENABLE_SSO: "true" });
    assert.equal(c.enableSso, true);
    assert.equal(c.username, undefined);
  });

  it("validates numbers and booleans", () => {
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_PORT: "70000" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_MAX_ROWS: "0" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_MAX_ROWS: "abc" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_ALLOW_WRITES: "maybe" }), ConfigError);
    assert.equal(parseBoolean("X", "OFF", true), false);
    assert.equal(parseBoolean("X", undefined, true), true);
  });
});

describe("redaction", () => {
  it("never includes the password or token in the URI", () => {
    const c = parseConfig({ ...base });
    assert.equal(redactedUri(c), "gizmosql://alice:***@db.internal:31337");
    const t = parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_TOKEN: "secret-token", GIZMOSQL_PLAINTEXT: "1" });
    const uri = redactedUri(t);
    assert.equal(uri, "gizmosql://token:***@h:31337?transport=tcp");
    assert.ok(!uri.includes("secret-token"));
  });

  it("redacts raw and URL-encoded secrets from messages", () => {
    const msg = "auth failed for p@ss word / p%40ss%20word / tok";
    assert.equal(redactSecrets(msg, ["p@ss word", "tok", undefined, ""]), "auth failed for *** / *** / ***");
  });

  it("connection.redact covers configured secrets", () => {
    const c = parseConfig({ ...base, GIZMOSQL_MCP_BEARER_TOKEN: "bearer-xyz" });
    const conn = new GizmoConnection(c, () => undefined);
    assert.equal(conn.redact("pw=p@ss word bearer-xyz"), "pw=*** ***");
  });
});

describe("isConnectionError", () => {
  it("recognises connection-level failures", () => {
    assert.equal(isConnectionError(new Error("rpc error: code = Unavailable desc = connection refused")), true);
    assert.equal(isConnectionError(new Error("transport is closing")), true);
    assert.equal(isConnectionError(new Error("Catalog Error: Table with name x does not exist!")), false);
    const named = Object.assign(new Error("x"), { name: "ConnectionError" });
    assert.equal(isConnectionError(named), true);
    const auth = Object.assign(new Error("x"), { name: "AuthenticationError" });
    assert.equal(isConnectionError(auth), false);
  });
});
