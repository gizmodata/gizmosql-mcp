#!/usr/bin/env bash
# Builds the Claude Desktop extension bundle: build/gizmosql-mcp-<version>.mcpb
# plus a .sha256 checksum file.
#
# Bundle layout:
#   manifest.json, package.json, icon.png, LICENSE, README.md, CHANGELOG.md
#   server/            compiled JS (entry point server/cli.js)
#   server/drivers/<platform>-<arch>/libadbc_driver_gizmosql.*   (all platforms)
#   node_modules/      production dependencies incl. every
#                      @apache-arrow/adbc-driver-manager-* prebuild
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
BUILD_DIR="$ROOT/build"
BUNDLE="$BUILD_DIR/bundle"
OUT="$BUILD_DIR/gizmosql-mcp-${VERSION}.mcpb"

echo "==> Building gizmosql-mcp ${VERSION}"
npm run build

echo "==> Assembling bundle in ${BUNDLE}"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/server"
cp -R dist/. "$BUNDLE/server/"
cp LICENSE README.md CHANGELOG.md icon.png "$BUNDLE/"

# manifest.json with the version synced from package.json
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  m.version = process.argv[1];
  fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
' "$VERSION" "$BUNDLE/manifest.json"

# package.json without scripts (no postinstall inside the bundle) or bin
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  delete p.scripts; delete p.bin; delete p.files; delete p.allowScripts;
  p.main = "server/cli.js";
  fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n");
' "$BUNDLE/package.json"
cp package-lock.json "$BUNDLE/"

echo "==> Installing production dependencies (scripts disabled)"
(cd "$BUNDLE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$BUNDLE/package-lock.json"

echo "==> Adding @apache-arrow/adbc-driver-manager prebuilds for every supported platform"
DM_VERSION="$(node -p "require('./node_modules/@apache-arrow/adbc-driver-manager/package.json').version")"
PKG_CACHE="$BUILD_DIR/npm-cache"
mkdir -p "$PKG_CACHE"
for target in darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu win32-x64-msvc; do
  pkg="@apache-arrow/adbc-driver-manager-${target}"
  dest="$BUNDLE/node_modules/$pkg"
  if [ -f "$dest/package.json" ]; then
    echo "    $pkg@$DM_VERSION already present"
    continue
  fi
  tgz="$PKG_CACHE/apache-arrow-adbc-driver-manager-${target}-${DM_VERSION}.tgz"
  if [ ! -f "$tgz" ]; then
    (cd "$PKG_CACHE" && npm pack "${pkg}@${DM_VERSION}" --silent >/dev/null)
  fi
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest" --strip-components=1
  echo "    $pkg@$DM_VERSION"
done

echo "==> Fetching native GizmoSQL ADBC drivers for every supported platform"
rm -rf "$BUNDLE/node_modules/@gizmodata/gizmosql-client/drivers"
node scripts/fetch-drivers.mjs --out "$BUNDLE/server/drivers" --cache "$ROOT/drivers/cache"

echo "==> Validating manifest and packing"
npx mcpb validate "$BUNDLE/manifest.json"
rm -f "$OUT"
npx mcpb pack "$BUNDLE" "$OUT"

# Versioned artifact plus an unversioned copy, so the GitHub "latest" URL
# (https://github.com/gizmodata/gizmosql-mcp/releases/latest/download/gizmosql-mcp.mcpb)
# always points at the newest release.
LATEST="$BUILD_DIR/gizmosql-mcp.mcpb"
cp "$OUT" "$LATEST"
(cd "$BUILD_DIR" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" && shasum -a 256 "$(basename "$LATEST")" > "$(basename "$LATEST").sha256")
echo "==> Wrote $OUT and $LATEST"
cat "$OUT.sha256" "$LATEST.sha256"
