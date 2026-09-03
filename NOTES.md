# Implementation notes

Things learned while building this that differ from the original plan, plus
known limitations and follow-ups. Verified against `@gizmodata/gizmosql-client`
2.1.0, `@apache-arrow/adbc-driver-manager` 0.24.0, `@modelcontextprotocol/sdk`
1.30.0, `@anthropic-ai/mcpb` 2.1.2, GizmoSQL server v1.38.1 and Claude Desktop
1.44121.4 (macOS).

## Claude Desktop's Node runtime

- Claude Desktop 1.44121.4 is Electron 42.10.0, whose embedded Node is
  **24.18.1** (`main.log` reports `nodeVersion: '24.18.1'`; Electron's `DEPS`
  confirms it). That satisfies the client's Node >= 22 requirement, so the
  bundle does not ship its own runtime.
- The app ships no standalone `node` binary and its Electron `RunAsNode`
  fuse is **disabled**, so extensions are run through Electron's
  `utilityProcess` (a Node environment inside the app). Native addons
  therefore must be Node-API based: `@apache-arrow/adbc-driver-manager` is
  a napi-rs addon, which is ABI-stable across Node/Electron versions.
- Consequence for testing: you cannot smoke-test the bundle with
  `ELECTRON_RUN_AS_NODE=1 Claude.app/.../Claude server/cli.js` (it launches
  the GUI instead). Install the `.mcpb` in Claude Desktop to validate the
  addon + driver load under the real runtime. Logs land in
  `~/Library/Logs/Claude/mcp-server-gizmosql.log` (macOS) or
  `%APPDATA%\Claude\logs\` (Windows).
- Not yet verified: whether macOS applies quarantine to the bundled
  `.dylib` when Claude Desktop extracts the `.mcpb`. The Python wheels of the
  same driver install fine, but do a manual install on a clean Mac before
  the first public release.

## Client (`@gizmodata/gizmosql-client`) gaps

- **No streaming execute.** `execute()` returns a fully materialized Arrow
  `Table`, so "stop reading batches at max_rows" cannot be implemented from
  the public API. The row cap is enforced by wrapping reads in
  `SELECT * FROM (...) LIMIT n+1` (server-side) and slicing only for
  statements that cannot be wrapped (`PRAGMA`, `EXPLAIN`). Proposed client
  addition: `executeStream(sql, params): AsyncIterable<RecordBatch>` over
  `conn.queryStream()` with `reader.cancel()` (the ADBC reader already
  exposes it; the client uses it internally in `getQuerySchema`).
- **No cancellation API.** The only way to abort an in-flight statement is
  `close()` on the client, which the Go driver relays as a Flight SQL
  cancel. `GizmoConnection.run()` does exactly that when the client-side
  deadline fires, then reopens lazily.
- **No pass-through of ADBC options.** The Go driver supports
  `adbc.gizmosql.auth_type=external` (OAuth in the driver),
  `adbc.gizmosql.oauth.*`, and Flight SQL RPC timeouts, but
  `FlightClientConfig` cannot pass them. A generic `databaseOptions`
  override in the client would let this server drop its own SSO flow and
  set RPC timeouts.
- `getPrimaryKeys()` (ADBC `GetObjects` depth All) returned no rows for a
  table with a `PRIMARY KEY` on GizmoSQL v1.38.1; `describe_table` uses
  `duckdb_constraints()` instead.
- The client's `driver-manifest.json` pins gizmosql-adbc **2.0.10** while
  2.0.11 is the latest release; re-pin in the client (`scripts/pin-driver.mjs`)
  and this bundle picks it up automatically at the next build.
- npm >= 11.19 gates install scripts: the client's postinstall driver
  download is skipped until `npm install-scripts approve @gizmodata/gizmosql-client`
  is run (this repo records the approval in `package.json` `allowScripts`).
  Worth documenting in the client README.
- Windows ARM64: gizmosql-adbc publishes a `windows_arm64` driver, but
  `@apache-arrow/adbc-driver-manager` 0.24.0 has no win32-arm64 prebuild, so
  the client (and this bundle) cannot run there. The bundle prints a clear
  error naming the platform.

## Server-side features used

- `SET gizmosql.query_timeout = N` (session scope, community edition)
  cancels statements server-side; the connection stays usable afterwards.
  Older servers without it produce a warning in `server_info`
  (`session_warnings`) and rely on the client-side deadline.
- `GIZMOSQL_VERSION()` / `version()` / `GIZMOSQL_USER()` for `server_info`,
  with Flight SQL `SqlInfo` (server name/version) as fallback.
- DuckDB `SHOW`, `DESCRIBE`, `SUMMARIZE`, `FROM`, `VALUES` and `TABLE` can be
  used as subqueries and are wrapped; `PRAGMA`/`EXPLAIN` cannot.
- Query/session tags (`SET gizmosql.query_tag`, `SET gizmosql.session_tag`)
  are an Enterprise (instrumentation) feature and were intentionally left
  out of v1; a `GIZMOSQL_QUERY_TAG` option could be added later
  (best-effort, ignore "commercially licensed enterprise feature" errors).

## MCP SDK / MCPB details

- `McpServer.registerTool` accepts zod v4 raw shapes; `outputSchema` makes
  the SDK validate `structuredContent` (used by `run_query`).
- `StreamableHTTPServerTransport.handleRequest(req, res)` works with
  Node's `http` module directly; no Express needed. Stateless mode = a new
  `McpServer` + transport per request sharing one `GizmoConnection`.
- `ResourceTemplate` requires an explicit `list` callback; ours lists up to
  500 tables.
- Tool names use underscores only (Claude Desktop rejects dots).
- The `.mcpb` bundles all five `@apache-arrow/adbc-driver-manager-*` napi
  packages (fetched with `npm pack`) plus five drivers, so it is ~150 MB
  unpacked / ~80 MB zipped. `mcpb clean` could trim `node_modules` further.

## Formatting details

- Arrow JS returns decimals as unscaled big numbers; `formatDecimal` applies
  the column scale. Timestamps arrive as epoch milliseconds (sub-millisecond
  precision is lost in rendering). Intervals are rendered as
  `"<months> months <days> days <seconds> seconds"`.
- Cells are truncated by Unicode code points so emoji/CJK are never split.
