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
  useStatement,
  envKey,
} from "../../dist/connection.js";
import { ConnectionRegistry } from "../../dist/registry.js";

const base = {
  GIZMOSQL_HOST: "db.internal",
  GIZMOSQL_USERNAME: "alice",
  GIZMOSQL_PASSWORD: "p@ss word",
};

describe("parseConfig", () => {
  const first = (env: Record<string, string>) => parseConfig(env).connections[0];

  it("applies defaults", () => {
    const cfg = parseConfig({ ...base });
    const c = cfg.connections[0];
    assert.equal(cfg.connections.length, 1);
    assert.equal(c.name, DEFAULTS.connectionName);
    assert.equal(c.host, "db.internal");
    assert.equal(c.port, DEFAULTS.port);
    assert.equal(c.username, "alice");
    assert.equal(c.password, "p@ss word");
    assert.equal(c.token, undefined);
    assert.equal(c.plaintext, false);
    assert.equal(c.tlsSkipVerify, false);
    assert.equal(c.oauthPort, DEFAULTS.oauthPort);
    assert.equal(c.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    assert.equal(cfg.allowWrites, false);
    assert.equal(cfg.maxRows, DEFAULTS.maxRows);
    assert.equal(cfg.maxCellChars, DEFAULTS.maxCellChars);
    assert.equal(cfg.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    assert.equal(cfg.mcpBearerToken, undefined);
    assert.equal(cfg.enableSso, false);
  });

  it("parses overrides", () => {
    const cfg = parseConfig({
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
      GIZMOSQL_CONNECTION_NAME: "prod",
    });
    const c = cfg.connections[0];
    assert.equal(c.name, "prod");
    assert.equal(c.port, 31338);
    assert.equal(c.token, "tok");
    assert.equal(c.username, undefined);
    assert.equal(c.plaintext, true);
    assert.equal(c.tlsSkipVerify, true);
    assert.equal(c.oauthPort, 1234);
    assert.equal(c.queryTimeoutSeconds, 0);
    assert.equal(cfg.allowWrites, true);
    assert.equal(cfg.maxRows, 10);
    assert.equal(cfg.maxCellChars, 50);
    assert.equal(cfg.queryTimeoutSeconds, 0);
    assert.equal(cfg.mcpBearerToken, "bearer");
  });

  it("requires a host and exactly one auth method", () => {
    assert.throws(() => parseConfig({}), /GIZMOSQL_HOST is required/);
    assert.throws(() => parseConfig({ GIZMOSQL_HOST: "h" }), /no credentials/);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_TOKEN: "t" }), /not both/);
    assert.throws(() => parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_USERNAME: "u" }), /must be set together/);
    assert.throws(() => parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_PASSWORD: "p" }), /must be set together/);
  });

  it("allows an empty password when the username is set", () => {
    const c = first({ GIZMOSQL_HOST: "h", GIZMOSQL_USERNAME: "u", GIZMOSQL_PASSWORD: "" });
    assert.equal(c.username, "u");
    assert.equal(c.password, "");
  });

  it("treats unsubstituted MCPB placeholders as unset (Claude Desktop passes them for blank fields)", () => {
    const c = first({
      GIZMOSQL_HOST: "h",
      GIZMOSQL_USERNAME: "u",
      GIZMOSQL_PASSWORD: "p",
      GIZMOSQL_TOKEN: "${user_config.token}",
      GIZMOSQL_PORT: "${user_config.port}",
      GIZMOSQL_PLAINTEXT: "${user_config.plaintext}",
      GIZMOSQL_2_HOST: "${user_config.connection2_host}",
      GIZMOSQL_2_NAME: "${user_config.connection2_name}",
    });
    assert.equal(c.token, undefined);
    assert.equal(c.username, "u");
    assert.equal(c.port, DEFAULTS.port);
    assert.equal(c.plaintext, false);
    const t = first({
      GIZMOSQL_HOST: "h",
      GIZMOSQL_USERNAME: "${user_config.username}",
      GIZMOSQL_PASSWORD: "${user_config.password}",
      GIZMOSQL_TOKEN: "tok",
    });
    assert.equal(t.token, "tok");
    assert.equal(t.username, undefined);
    assert.throws(() => parseConfig({ GIZMOSQL_HOST: "${user_config.host}" }), /GIZMOSQL_HOST is required/);
  });

  it("parses optional default catalog/schema", () => {
    const c = first({ ...base });
    assert.equal(c.defaultCatalog, undefined);
    assert.equal(c.defaultSchema, undefined);
    const d = first({ ...base, GIZMOSQL_DEFAULT_CATALOG: "lake", GIZMOSQL_DEFAULT_SCHEMA: " sales " });
    assert.equal(d.defaultCatalog, "lake");
    assert.equal(d.defaultSchema, "sales");
  });

  it("builds quoted USE statements", () => {
    assert.equal(useStatement({}), null);
    assert.equal(useStatement({ catalog: "lake" }), 'USE "lake"');
    assert.equal(useStatement({ schema: "sales" }), 'USE "sales"');
    assert.equal(useStatement({ catalog: 'my"lake', schema: "sales" }), 'USE "my""lake"."sales"');
  });

  it("allows no credentials when SSO is enabled", () => {
    const cfg = parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_ENABLE_SSO: "true" });
    assert.equal(cfg.enableSso, true);
    assert.equal(cfg.connections[0].username, undefined);
  });

  it("validates numbers and booleans", () => {
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_PORT: "70000" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_MAX_ROWS: "0" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_MAX_ROWS: "abc" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, GIZMOSQL_ALLOW_WRITES: "maybe" }), ConfigError);
    assert.equal(parseBoolean("X", "OFF", true), false);
    assert.equal(parseBoolean("X", undefined, true), true);
  });

  describe("multiple connections", () => {
    it("reads the manifest slots 2 and 3 with default names", () => {
      const cfg = parseConfig({
        ...base,
        GIZMOSQL_2_HOST: "h2",
        GIZMOSQL_2_TOKEN: "t2",
        GIZMOSQL_2_PORT: "444",
        GIZMOSQL_2_DEFAULT_CATALOG: "lake",
        GIZMOSQL_3_HOST: "h3",
        GIZMOSQL_3_NAME: "Staging",
        GIZMOSQL_3_USERNAME: "u3",
        GIZMOSQL_3_PASSWORD: "p3",
        GIZMOSQL_3_PLAINTEXT: "true",
      });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["default", "server2", "Staging"]);
      assert.equal(cfg.connections[1].token, "t2");
      assert.equal(cfg.connections[1].port, 444);
      assert.equal(cfg.connections[1].defaultCatalog, "lake");
      assert.equal(cfg.connections[2].plaintext, true);
      assert.equal(cfg.connections[2].queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    });

    it("ignores slots without a host", () => {
      const cfg = parseConfig({ ...base, GIZMOSQL_2_NAME: "ghost", GIZMOSQL_2_TOKEN: "x", GIZMOSQL_3_PORT: "1" });
      assert.equal(cfg.connections.length, 1);
    });

    it("reads GIZMOSQL_CONNECTIONS names from GIZMOSQL_<NAME>_* variables", () => {
      const cfg = parseConfig({
        ...base,
        GIZMOSQL_CONNECTIONS: "prod, dev-eu",
        GIZMOSQL_PROD_HOST: "prod.internal",
        GIZMOSQL_PROD_TOKEN: "pt",
        GIZMOSQL_DEV_EU_HOST: "dev.internal",
        GIZMOSQL_DEV_EU_USERNAME: "d",
        GIZMOSQL_DEV_EU_PASSWORD: "dp",
        GIZMOSQL_DEV_EU_NAME: "dev",
      });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["default", "prod", "dev"]);
      assert.equal(envKey("dev-eu"), "DEV_EU");
    });

    it("a listed connection without a host is ignored, and the primary may be absent when others exist", () => {
      const cfg = parseConfig({ GIZMOSQL_CONNECTIONS: "prod", GIZMOSQL_PROD_HOST: "p", GIZMOSQL_PROD_TOKEN: "t" });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["prod"]);
    });

    it("validates every connection and rejects duplicate names", () => {
      assert.throws(
        () => parseConfig({ ...base, GIZMOSQL_2_HOST: "h2" }),
        /Connection "server2" \(GIZMOSQL_2_HOST\) has no credentials/,
      );
      assert.throws(
        () => parseConfig({ ...base, GIZMOSQL_2_HOST: "h2", GIZMOSQL_2_TOKEN: "t", GIZMOSQL_2_NAME: "DEFAULT" }),
        /used more than once/,
      );
      assert.throws(
        () => parseConfig({ ...base, GIZMOSQL_2_HOST: "h2", GIZMOSQL_2_TOKEN: "t", GIZMOSQL_2_NAME: "bad name!" }),
        /must be 1-64 letters/,
      );
    });
  });
});

describe("redaction", () => {
  it("never includes the password or token in the URI", () => {
    const c = parseConfig({ ...base }).connections[0];
    assert.equal(redactedUri(c), "gizmosql://alice:***@db.internal:31337");
    const t = parseConfig({ GIZMOSQL_HOST: "h", GIZMOSQL_TOKEN: "secret-token", GIZMOSQL_PLAINTEXT: "1" }).connections[0];
    const uri = redactedUri(t);
    assert.equal(uri, "gizmosql://token:***@h:31337?transport=tcp");
    assert.ok(!uri.includes("secret-token"));
  });

  it("redacts raw and URL-encoded secrets from messages", () => {
    const msg = "auth failed for p@ss word / p%40ss%20word / tok";
    assert.equal(redactSecrets(msg, ["p@ss word", "tok", undefined, ""]), "auth failed for *** / *** / ***");
  });

  it("connection.redact covers configured secrets", () => {
    const cfg = parseConfig({ ...base, GIZMOSQL_MCP_BEARER_TOKEN: "bearer-xyz" });
    const conn = new GizmoConnection(cfg.connections[0], () => undefined);
    assert.equal(conn.redact("pw=p@ss word bearer-xyz"), "pw=*** bearer-xyz");
    const registry = new ConnectionRegistry(cfg, () => undefined);
    assert.equal(registry.redact("pw=p@ss word bearer-xyz"), "pw=*** ***");
    assert.equal(registry.current(), "default");
    assert.throws(() => registry.get("nope"), /Unknown connection "nope". Available connections: default/);
    assert.equal(registry.get("DEFAULT").config.name, "default");
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
