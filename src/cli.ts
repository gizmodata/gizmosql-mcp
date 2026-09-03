#!/usr/bin/env node
// Entrypoint: `gizmosql-mcp [--transport stdio|http] [--port N] [--host H]`.
//
// Bundled-driver resolution happens here, before the client is imported:
// when a `drivers/<platform>-<arch>/` directory sits next to this file
// (the .mcpb layout), point the client at it and disable downloads.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DRIVER_EXT: Record<string, string> = { darwin: ".dylib", linux: ".so", win32: ".dll" };

function configureBundledDriver(): void {
  if (process.env.GIZMOSQL_DRIVER_LIB) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const driversDir = path.join(here, "drivers");
  if (!fs.existsSync(driversDir)) return; // npm layout: the client's own download is used
  const key = `${process.platform}-${process.arch}`;
  const ext = DRIVER_EXT[process.platform];
  const lib = ext ? path.join(driversDir, key, `libadbc_driver_gizmosql${ext}`) : undefined;
  if (!lib || !fs.existsSync(lib)) {
    let available: string[] = [];
    try {
      available = fs.readdirSync(driversDir).filter((d) => !d.startsWith("."));
    } catch {
      // ignore
    }
    console.error(
      `[gizmosql-mcp] No bundled GizmoSQL ADBC driver for this platform (${key}). ` +
        `Bundled platforms: ${available.join(", ") || "none"}. ` +
        "Set GIZMOSQL_DRIVER_LIB to a libadbc_driver_gizmosql library built for this platform " +
        "(https://github.com/gizmodata/gizmosql-adbc).",
    );
    process.exit(1);
  }
  process.env.GIZMOSQL_DRIVER_SKIP_DOWNLOAD = "1";
  process.env.GIZMOSQL_DRIVER_LIB = lib;
}

function usage(): string {
  return [
    "Usage: gizmosql-mcp [--transport stdio|http] [--port N] [--host H]",
    "",
    "  --transport  stdio (default) or http (Streamable HTTP on /mcp)",
    "  --port       HTTP port (default 3000; http transport only)",
    "  --host       HTTP bind address (default 127.0.0.1; http transport only)",
    "  --help       show this help",
    "",
    "Configuration is read from GIZMOSQL_* environment variables (see README).",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      transport: { type: "string", default: "stdio" },
      port: { type: "string", default: "3000" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  configureBundledDriver();

  const { PACKAGE_VERSION } = await import("./version.js");
  if (values.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  const transport = values.transport;
  if (transport !== "stdio" && transport !== "http") {
    console.error(`Unknown --transport "${transport}".\n\n${usage()}`);
    process.exit(2);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port "${values.port}".`);
    process.exit(2);
  }

  const { parseConfig, ConfigError } = await import("./connection.js");
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[gizmosql-mcp] configuration error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const { startStdio, startHttp } = await import("./transports.js");
  if (transport === "stdio") {
    await startStdio(config);
  } else {
    await startHttp(config, { host: values.host, port });
  }
}

main().catch((err) => {
  console.error(`[gizmosql-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
