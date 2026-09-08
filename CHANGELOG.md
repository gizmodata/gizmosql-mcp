# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.6] - 2026-09-08

### Added
- Every successful tool result now includes `mcp_server_version` in its
  structured content (and `run_query`'s output schema). Claude Desktop shows
  structured content to the model but not `_meta`, so the version added in
  0.3.4 was invisible there.

## [0.3.5] - 2026-09-08

### Fixed
- `describe_table` failed outright in 0.3.4 when the one-row estimate probe
  was refused (GizmoSQL's system-managed instrumentation catalog is
  admin-only). A refused probe now leaves `estimated_rows` as `null`.

### Added
- The schema-dialect unit test now compiles every advertised tool schema
  with a 2020-12-only Ajv validator, the same check that rejected
  `run_query` in Claude Desktop, with a draft-07 control that must fail.

## [0.3.4] - 2026-09-08

### Changed
- `list_schemas` hides system schemas (`information_schema`, `pg_catalog`,
  `pg_toast`, `pg_temp_*`, `pg_toast_temp_*`) by default and reports how
  many were hidden. Attached Postgres databases expose hundreds of
  `pg_temp_N` schemas, which made the unfiltered call unusable. Pass
  `include_system: true` to list them.

### Added
- Every tool result carries `_meta.gizmosql_mcp` with the server name and
  version, so a client can tell which build answered without calling
  `server_info`.

### Fixed
- `describe_table` no longer reports `estimated_rows: 0` for populated
  tables DuckDB has no statistics for (attached Postgres catalogs). A
  one-row probe turns that into `null` (unknown) when data exists.

## [0.3.3] - 2026-09-08

### Fixed
- Tool schemas are now advertised as JSON Schema 2020-12. The MCP SDK stamps
  `"$schema": draft-07` on every Zod-derived schema (typescript-sdk #2721),
  and newer Claude Desktop builds reject `run_query` before calling it with
  "invalid outputSchema: JSON Schema declares an unsupported dialect".

## [0.3.2] - 2026-09-03

### Changed
- Extension settings order: default catalog/schema now follow the username
  and password for each connection.

## [0.3.1] - 2026-09-03

### Removed
- The separate bearer-token setting (`GIZMOSQL_TOKEN`, `GIZMOSQL_<n>_TOKEN`,
  the "Bearer token" extension fields). GizmoSQL's token authentication is
  basic authentication with username `token` and the JWT as the password,
  so the extra field only caused confusion. Configure JWTs that way instead.

## [0.3.0] - 2026-09-03

### Added
- **Multiple connections.** Up to two additional servers in the extension
  settings (*Connection 2* / *Connection 3*, mapped to `GIZMOSQL_2_*` /
  `GIZMOSQL_3_*`), and any number via `GIZMOSQL_CONNECTIONS=name,...` with
  `GIZMOSQL_<NAME>_*` variables. New tools `list_connections` and
  `use_connection`; every other tool takes an optional `connection`
  argument. `GIZMOSQL_CONNECTION_NAME` names the primary connection
  (default `default`). `server_info` reports all connections.

### Changed
- Table DDL resource URIs now include the connection:
  `gizmosql://{connection}/schema/{catalog}/{schema}/{table}` (previously
  `gizmosql://schema/...`).

## [0.2.2] - 2026-09-03

### Added
- Each release now also attaches an unversioned `gizmosql-mcp.mcpb` (and
  `.sha256`), so the stable link
  https://github.com/gizmodata/gizmosql-mcp/releases/latest/download/gizmosql-mcp.mcpb
  always downloads the newest bundle. The README links to it.

## [0.2.1] - 2026-09-03

### Fixed
- Table DDL resources now carry a per-table `title` (`catalog.schema.table`),
  so Claude Desktop's "Add from GizmoSQL" picker shows table names instead
  of "Table DDL" for every entry.

## [0.2.0] - 2026-09-03

### Added
- Optional default catalog and schema (`GIZMOSQL_DEFAULT_CATALOG`,
  `GIZMOSQL_DEFAULT_SCHEMA`; extension settings "Default catalog" /
  "Default schema"). The server runs `USE` on every new session, reports
  the values in `server_info`, and if the name does not exist it keeps
  running and lists the available catalogs in `session_warnings`.
- `use_schema(catalog?, schema?)` tool to switch the session's default
  catalog/schema from a chat; the choice is re-applied after reconnects.

### Changed
- `USE` is now allowed in read-only mode (it only changes the session's
  search path).

## [0.1.1] - 2026-09-03

### Fixed
- Claude Desktop passes the literal `${user_config.<key>}` placeholder for
  optional settings left blank (e.g. the bearer token when using a
  username/password). These are now treated as unset; previously the
  server exited at startup with "Set either GIZMOSQL_USERNAME/
  GIZMOSQL_PASSWORD or GIZMOSQL_TOKEN, not both" and Desktop showed
  "Unable to connect to extension server".

## [0.1.0] - 2026-09-03

### Added
- Initial MCP server for GizmoSQL built on `@gizmodata/gizmosql-client` 2.x
  (native GizmoSQL ADBC driver) and `@modelcontextprotocol/sdk`.
- Tools: `list_catalogs`, `list_schemas`, `list_tables`, `describe_table`,
  `run_query` (parameter binding, row cap, cell truncation, structured JSON
  output), `explain_query`, `server_info`, and `execute_statement` (only
  when `GIZMOSQL_ALLOW_WRITES=true`).
- Optional `login_sso` tool (`GIZMOSQL_ENABLE_SSO=true`) implementing the
  GizmoSQL OAuth/SSO browser flow; the identity token is kept in memory only.
- `gizmosql://schema/{catalog}/{schema}/{table}` resource returning table/view
  DDL.
- Read-only guard (`sql-guard.ts`) that rejects non-read statements,
  including CTEs ending in DML, `COPY`, `ATTACH`, `INSTALL`, `SET`, etc.
- Row cap enforced server-side by wrapping reads in
  `SELECT * FROM (...) LIMIT n+1` and by streaming batches that stop at the
  cap (`executeStream`); query timeout enforced server-side via
  `SET gizmosql.query_timeout` with a client-side `AbortSignal` deadline as
  backstop (requires `@gizmodata/gizmosql-client` 2.2.0).
- Transports: stdio (default) and stateless Streamable HTTP (`--transport http`,
  `/mcp`) with optional `GIZMOSQL_MCP_BEARER_TOKEN` authentication.
- Claude Desktop extension packaging (`manifest.json`, `scripts/build-mcpb.sh`)
  bundling the native driver for macOS (arm64/x64), Linux (x64/arm64) and
  Windows x64, verified against the client's `driver-manifest.json`.
- Privacy Policy section in the README and `privacy_policies` in the manifest
  (required for Anthropic's Connectors Directory).
- Unit tests (guard, formatting, parameters, config) and Docker-based
  integration tests; GitHub Actions CI and tag-triggered release workflow
  (GitHub Release with `.mcpb` + checksum, npm publish).
