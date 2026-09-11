// The idle-session refresh against real GizmoSQL servers on both sides of
// the gizmosql_settings() startup rows (added in GizmoSQL 1.38.5):
//   - 1.38.4 reports nothing, so the MCP server falls back to its default
//     refresh (60s) unless GIZMOSQL_SESSION_REFRESH_SECONDS is set;
//   - 1.38.5 reports gizmosql.session_idle_timeout, and the refresh follows it.
// Each server runs with a 3-second idle timeout; the sweep is every second.
// Needs Docker (skipped otherwise); pulls the two images on first run.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as net from "node:net";
import { after, before, describe, it } from "node:test";

import { FlightSQLClient } from "@gizmodata/gizmosql-client";

import { GizmoConnection, parseConfig } from "../../dist/connection.js";

const OLD_IMAGE = process.env.GIZMOSQL_TEST_IMAGE_OLD ?? "gizmodata/gizmosql:v1.38.4";
const NEW_IMAGE = process.env.GIZMOSQL_TEST_IMAGE_NEW ?? "gizmodata/gizmosql:v1.38.5";
const USERNAME = "gizmosql";
const PASSWORD = "gizmosql_mcp_test_password";
const IDLE_SECONDS = 3;
/** Comfortably past the idle timeout plus the one-second sweep. */
const PAST_IDLE_MS = (IDLE_SECONDS + 2) * 1000;

interface Server {
  image: string;
  port: number;
  stop: () => void;
  /** Restarts the container in place (same host port); resolves when it serves again. */
  restart: () => Promise<void>;
}

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A currently free localhost port. A fixed publish keeps the mapping across `docker restart`; `:0` would not. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(image: string, tag: string): Promise<Server> {
  const name = `gizmosql-mcp-versions-${tag}-${process.pid}`;
  const port = await freePort();
  execFileSync("docker", [
    "run", "--detach", "--rm", "--tty", "--init",
    "--name", name,
    "--publish", `127.0.0.1:${port}:31337`,
    "--env", "TLS_ENABLED=1",
    "--env", `GIZMOSQL_USERNAME=${USERNAME}`,
    "--env", `GIZMOSQL_PASSWORD=${PASSWORD}`,
    "--env", `GIZMOSQL_SESSION_IDLE_TIMEOUT=${IDLE_SECONDS}`,
    image,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const stop = () => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  };
  // The in-memory database is empty after every (re)start: recreate the fixture.
  const ready = async () => {
    const deadline = Date.now() + 90000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const client = new FlightSQLClient({ host: "127.0.0.1", port, tlsSkipVerify: true, username: USERNAME, password: PASSWORD });
      try {
        await client.execute("CREATE SCHEMA IF NOT EXISTS memory.mcp_ver");
        await client.execute("CREATE OR REPLACE TABLE memory.mcp_ver.whoami AS SELECT 'mcp_ver' AS schema_name");
        await client.close();
        return;
      } catch (err) {
        lastError = err;
        await client.close().catch(() => undefined);
        await sleep(1000);
      }
    }
    throw new Error(`${image} not ready: ${lastError instanceof Error ? lastError.message : lastError}`);
  };
  try {
    await ready();
  } catch (err) {
    stop();
    throw err;
  }
  const restart = async () => {
    execFileSync("docker", ["restart", name], { stdio: ["ignore", "ignore", "inherit"] });
    await ready();
  };
  return { image, port, stop, restart };
}

/** A connection whose unqualified names resolve in memory.mcp_ver only while the search path holds. */
function connect(server: Server, env: Record<string, string> = {}) {
  const cfg = parseConfig({
    GIZMOSQL_HOST: "127.0.0.1",
    GIZMOSQL_PORT: String(server.port),
    GIZMOSQL_USERNAME: USERNAME,
    GIZMOSQL_PASSWORD: PASSWORD,
    GIZMOSQL_TLS_SKIP_VERIFY: "true",
    GIZMOSQL_DEFAULT_CATALOG: "memory",
    GIZMOSQL_DEFAULT_SCHEMA: "mcp_ver",
    ...env,
  });
  const logs: string[] = [];
  const conn = new GizmoConnection(cfg.connections[0], (m) => logs.push(m));
  return { conn, logs };
}

async function schemaSeenBy(conn: GizmoConnection): Promise<string> {
  const t = await conn.query("SELECT schema_name FROM whoami");
  return String(t.getChildAt(0)?.get(0));
}

describe("idle session refresh against real servers", { skip: dockerAvailable ? false : "Docker not available" }, () => {
  let oldServer: Server;
  let newServer: Server;

  before(async () => {
    [oldServer, newServer] = await Promise.all([startServer(OLD_IMAGE, "old"), startServer(NEW_IMAGE, "new")]);
  });

  after(() => {
    oldServer?.stop();
    newServer?.stop();
  });

  it(`${NEW_IMAGE}: reports its idle timeout, and the refresh restores the search path after eviction`, async () => {
    const { conn, logs } = connect(newServer);
    try {
      assert.equal(await schemaSeenBy(conn), "mcp_ver");
      const settings = conn.serverSettingsSnapshot();
      assert.equal(settings["gizmosql.session_idle_timeout"], String(IDLE_SECONDS), JSON.stringify(settings));
      assert.match(settings["gizmosql.version"] ?? "", /^v?1\.38\.[5-9]|^v?1\.(39|[4-9]\d)|^v?[2-9]\./u);
      assert.equal(conn.sessionRefreshThresholdSeconds(), Math.floor(IDLE_SECONDS * 0.9));
      assert.ok(logs.some((l) => /session refresh after 2s idle \(server session_idle_timeout 3/u.test(l)), logs.join("\n"));

      await sleep(PAST_IDLE_MS); // the server evicts the session and will silently recreate it
      assert.equal(await schemaSeenBy(conn), "mcp_ver", "search path survived eviction thanks to the refresh");
      assert.equal(conn.sessionRefreshes, 1);
    } finally {
      await conn.close();
    }
  });

  it(`${NEW_IMAGE}: a server restart under a live connection is survived by a transparent reconnect`, async () => {
    const { conn, logs } = connect(newServer);
    try {
      assert.equal(await schemaSeenBy(conn), "mcp_ver");
      await newServer.restart(); // the old session token now names a dead instance
      assert.equal(await schemaSeenBy(conn), "mcp_ver", "reconnected with a fresh handshake and search path");
      assert.ok(logs.some((l) => /session lost \(server restarted, or session evicted\/killed\), reconnecting/u.test(l)), logs.join("\n"));
    } finally {
      await conn.close();
    }
  });

  it(`${OLD_IMAGE}: reports no idle timeout, so the default refresh applies and the search path is lost in between`, async () => {
    const { conn, logs } = connect(oldServer);
    try {
      assert.equal(await schemaSeenBy(conn), "mcp_ver");
      assert.equal(conn.serverSettingsSnapshot()["gizmosql.session_idle_timeout"], undefined);
      assert.equal(conn.sessionRefreshThresholdSeconds(), 60);
      assert.ok(logs.some((l) => /session refresh after 60s idle \(server session_idle_timeout not reported\)/u.test(l)), logs.join("\n"));

      await sleep(PAST_IDLE_MS);
      // Evicted and silently recreated with the server's defaults: no error, wrong schema.
      await assert.rejects(schemaSeenBy(conn), /whoami|does not exist|Catalog Error/u);
      assert.equal(conn.sessionRefreshes, 0);
    } finally {
      await conn.close();
    }
  });

  it(`${OLD_IMAGE}: an explicit GIZMOSQL_SESSION_REFRESH_SECONDS below the server's idle timeout keeps it working`, async () => {
    const { conn } = connect(oldServer, { GIZMOSQL_SESSION_REFRESH_SECONDS: "2" });
    try {
      assert.equal(await schemaSeenBy(conn), "mcp_ver");
      assert.equal(conn.sessionRefreshThresholdSeconds(), 2);
      await sleep(PAST_IDLE_MS);
      assert.equal(await schemaSeenBy(conn), "mcp_ver");
      assert.equal(conn.sessionRefreshes, 1);
    } finally {
      await conn.close();
    }
  });
});
