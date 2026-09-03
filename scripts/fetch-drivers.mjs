#!/usr/bin/env node
// Pre-fetches the native GizmoSQL ADBC driver (libadbc_driver_gizmosql)
// for every platform the .mcpb bundle supports, so the bundle works
// offline. The driver version and per-platform SHA-256 hashes come from
// the installed @gizmodata/gizmosql-client's driver-manifest.json — the
// same source its own postinstall downloader uses.
//
// Usage: node scripts/fetch-drivers.mjs --out <dir> [--platforms a,b] [--cache <dir>]
//
// Output layout: <dir>/<node platform>-<node arch>/libadbc_driver_gizmosql.<ext>

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as zlib from "node:zlib";

const require = createRequire(import.meta.url);

const REPO = "gizmodata/gizmosql-adbc";
const LIB_BASENAME = "libadbc_driver_gizmosql";

/**
 * Node platform-arch -> gizmosql-adbc release asset key. Windows ARM64 is
 * published by gizmosql-adbc but @apache-arrow/adbc-driver-manager ships
 * no win32-arm64 prebuild, so it is excluded by default.
 */
export const PLATFORMS = {
  "darwin-arm64": { asset: "macos_arm64", ext: ".dylib", supported: true },
  "darwin-x64": { asset: "macos_amd64", ext: ".dylib", supported: true },
  "linux-x64": { asset: "linux_amd64", ext: ".so", supported: true },
  "linux-arm64": { asset: "linux_arm64", ext: ".so", supported: true },
  "win32-x64": { asset: "windows_amd64", ext: ".dll", supported: true },
  "win32-arm64": { asset: "windows_arm64", ext: ".dll", supported: false },
};

function readClientManifest() {
  const manifestPath = require.resolve("@gizmodata/gizmosql-client/driver-manifest.json");
  return { path: manifestPath, ...JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
}

/** Minimal tar reader: returns the first regular file whose basename matches. */
function extractFromTar(tarBuffer, wantedBasename) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if ((typeflag === "0" || typeflag === "\0" || typeflag === "") && path.posix.basename(fullName) === wantedBasename) {
      return tarBuffer.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wantedBasename} not found in archive`);
}

async function download(url) {
  const res = await fetch(url, { headers: { "user-agent": "gizmosql-mcp build" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchDrivers({ out, platforms, cache, log = console.log }) {
  const manifest = readClientManifest();
  const version = manifest.version;
  log(`[fetch-drivers] gizmosql-adbc v${version} (pinned by ${path.relative(process.cwd(), manifest.path)})`);
  fs.mkdirSync(out, { recursive: true });
  if (cache) fs.mkdirSync(cache, { recursive: true });

  const results = [];
  for (const key of platforms) {
    const info = PLATFORMS[key];
    if (!info) throw new Error(`Unknown platform ${key}; known: ${Object.keys(PLATFORMS).join(", ")}`);
    const expectedSha = (manifest.sha256 ?? {})[info.asset];
    if (!expectedSha) throw new Error(`driver-manifest.json has no SHA-256 for ${info.asset}`);

    const assetName = `${LIB_BASENAME}-v${version}-${info.asset}.tar.gz`;
    const url = `https://github.com/${REPO}/releases/download/v${version}/${assetName}`;
    const cached = cache ? path.join(cache, assetName) : undefined;

    let tarGz;
    if (cached && fs.existsSync(cached)) {
      tarGz = fs.readFileSync(cached);
      log(`[fetch-drivers] ${key}: using cached ${assetName}`);
    } else {
      log(`[fetch-drivers] ${key}: downloading ${url}`);
      tarGz = await download(url);
      if (cached) fs.writeFileSync(cached, tarGz);
    }
    const actualSha = createHash("sha256").update(tarGz).digest("hex");
    if (actualSha !== expectedSha.toLowerCase()) {
      if (cached) fs.rmSync(cached, { force: true });
      throw new Error(`SHA-256 mismatch for ${assetName}: expected ${expectedSha}, got ${actualSha}`);
    }
    const libFile = `${LIB_BASENAME}${info.ext}`;
    const lib = extractFromTar(zlib.gunzipSync(tarGz), libFile);
    const destDir = path.join(out, key);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, libFile);
    fs.writeFileSync(dest, lib, { mode: 0o755 });
    log(`[fetch-drivers] ${key}: ${path.relative(process.cwd(), dest)} (${(lib.length / 1048576).toFixed(1)} MB, sha256 ok)`);
    results.push({ platform: key, path: dest, version, sha256: actualSha });
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      platforms: { type: "string" },
      cache: { type: "string", default: path.join(process.cwd(), "drivers", "cache") },
      "include-unsupported": { type: "boolean", default: false },
    },
  });
  if (!values.out) {
    console.error("usage: fetch-drivers.mjs --out <dir> [--platforms darwin-arm64,linux-x64] [--cache <dir>]");
    process.exit(2);
  }
  const platforms = values.platforms
    ? values.platforms.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.entries(PLATFORMS)
        .filter(([, v]) => v.supported || values["include-unsupported"])
        .map(([k]) => k);
  fetchDrivers({ out: values.out, platforms, cache: values.cache }).catch((err) => {
    console.error(`[fetch-drivers] failed: ${err.message}`);
    process.exit(1);
  });
}
