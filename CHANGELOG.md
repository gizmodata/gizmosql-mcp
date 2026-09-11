# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.6] - 2026-09-11

### Fixed
- Hosted HTTP transport with Microsoft Entra ID: users were still disconnected
  about an hour after signing in, even with `offline_access` requested and a
  refresh token issued. Claude's `refresh_token` request carries only the
  OpenID Connect scopes and Entra refuses it with `AADSTS90009` because it
  names no resource (anthropics/claude-ai-mcp#840). New
  `GIZMOSQL_MCP_OAUTH_TOKEN_PROXY=true` publishes an authorization-server
  metadata facade at `/oauth` and proxies the token endpoint at
  `/oauth/token`, adding the configured API scope and `offline_access` to
  refresh grants; authorization-code exchanges pass through untouched. Every
  exchange is logged without secrets (grant, status, whether a refresh token
  came back, `expires_in`, the provider's error). The server warns at startup
  when the issuer is Entra and the proxy is off. Chart and deployment
  template enable it.

## [0.4.5] - 2026-09-10

### Fixed
- Hosted HTTP transport with OAuth: the documented scope setting requested
  only the API scope, so Microsoft Entra ID issued no refresh token and Claude
  lost the connector as soon as the access token expired (about an hour), with
  no way to re-authorize mid-conversation. The README, chart and deployment
  template now advertise `offline_access` (with `openid profile email`)
  alongside the API scope, and the server warns at startup when
  `GIZMOSQL_MCP_OAUTH_SCOPES` lacks it.
- Rejected bearer tokens (401) are now logged with the reason, as 403s already
  were, so an expired-token loop is visible in the pod logs.

## [0.4.4] - 2026-09-09

### Changed
- Requires `@gizmodata/gizmosql-client` >= 2.2.1, which bundles gizmosql-adbc
  v2.0.13: parameterized DDL/DML sent through `execute_statement` with bound
  parameters now executes immediately instead of running lazily on the server,
  where it could be silently lost or interrupted by the client's own cancel.

## [0.4.3] - 2026-09-09

### Added
- Integration coverage for the hosted HTTP transport (`test/integration/sessions.test.ts`,
  runs in the existing CI job against the GizmoSQL service container and a
  throwaway OpenID Connect issuer): per-user isolation of `use_schema`,
  `use_connection` and unqualified name resolution under concurrent bursts,
  idle-session expiry end to end, and a sweep over every registered tool that
  checks for structured content, the version stamp, and conformance to the
  declared output schema.
- Unit tests for `login_sso` (`test/unit/sso.test.ts`) and for the session
  reset notice.

### Changed
- When a user's HTTP session has expired and a new one starts, the first tool
  result says so (a note in the text and a `session_reset` field in the
  structured content) instead of silently applying the defaults.
- `GIZMOSQL_MCP_SESSION_IDLE_SECONDS` accepts values down to 1 second (was 30).

## [0.4.2] - 2026-09-09

### Changed
- `list_schemas` never lists the per-backend temporary schemas of an attached
  Postgres database (`pg_temp_N`, `pg_toast_temp_N`), even with
  `include_system: true`. They hold nothing usable, there is one pair per
  Postgres backend, and a busy attachment exposes hundreds of them. The
  result reports how many were skipped as `hidden_temp_schemas`.

## [0.4.1] - 2026-09-09

### Fixed
- Calling `run_query` or `execute_statement` with fewer (or more) values than
  the statement has placeholders is now rejected before the query is sent,
  with a message that states both counts, instead of surfacing DuckDB's
  "Values were not provided for the following prepared statement parameters"
  wrapped in Arrow and Flight SQL transport noise.
- Server errors are shown without the driver's wrappers (`Arrow Error: C Data
  interface error: [FlightSQL] An execution error has occurred:` and the
  trailing `(Unknown; DoGet: endpoint 0: [])`), whichever tool raised them.
- The note about the `LIMIT` wrapper offsetting line numbers is only added to
  errors that actually cite a line.

### Changed
- `list_schemas` explains that DuckDB keeps `information_schema` and
  `pg_catalog` in the `system` catalog only, so `include_system` does not add
  schemas to a user catalog.

## [0.4.0] - 2026-09-09

### Added
- OAuth for the Streamable HTTP transport. With `GIZMOSQL_MCP_OAUTH_ISSUER` and
  `GIZMOSQL_MCP_PUBLIC_URL` set, the server acts as an OAuth 2.1 resource server
  for any OpenID Connect provider that issues JWT access tokens (Microsoft Entra
  ID, Okta, Auth0, Keycloak, Cognito, Clerk): it discovers the provider's JWKS,
  verifies issuer, audience, signature and expiry on every request, serves the
  RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource`
  (and the `/mcp`-suffixed form), and answers 401 with the `WWW-Authenticate`
  challenge Claude.ai uses to start the sign-in flow. Optional
  `GIZMOSQL_MCP_OAUTH_AUTHORIZED_EMAILS` restricts callers to an email allowlist
  (403), `GIZMOSQL_MCP_OAUTH_AUDIENCE` accepts several audiences, and
  `GIZMOSQL_MCP_OAUTH_JWKS_URI` skips discovery. The caller's token is never
  forwarded: GizmoSQL is reached with the configured service credentials.
- Per-user sessions over HTTP. Each authenticated user gets their own
  GizmoSQL connections, current connection and search path, so `use_schema`,
  `USE` and `use_connection` no longer leak between people sharing one
  server. Sessions close after `GIZMOSQL_MCP_SESSION_IDLE_SECONDS` (default
  1800) without a request or when `GIZMOSQL_MCP_MAX_SESSIONS` (default 200)
  is reached, least recently used first. `server_info` reports
  `session_scope`, `session_started` and `session_idle_timeout_seconds`.
- Every JSON-RPC request over HTTP is logged with the authenticated caller and
  the tool or resource it touched, and `server_info` reports `authenticated_user`.
- A container image for the HTTP transport (`ghcr.io/gizmodata/gizmosql-mcp`,
  linux/amd64 and linux/arm64) and a Helm chart
  (`oci://ghcr.io/gizmodata/charts/gizmosql-mcp`), both published by the release
  workflow with versions locked to the npm package.

### Changed
- `GIZMOSQL_MCP_BEARER_TOKEN` and OAuth are mutually exclusive; configuring both
  is a startup error. The 401 for a static token now carries a JSON body.
- `login_sso` is only registered on the stdio transport; over HTTP it would
  open a browser on the server.

## [0.3.7] - 2026-09-08

### Fixed
- `explain_query` appeared to return only the version envelope in 0.3.6:
  it was the one tool without structured content, and hosts that show
  structured content in preference to text saw nothing else. It now returns
  `physical_plan` and `sections` as structured JSON alongside the Markdown.

### Added
- Error results end with the server name and version, so the build is
  identifiable exactly when a bug report needs it. (Errors cannot carry
  structured content: clients validate it against `run_query`'s output
  schema even for errors.)

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
