# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
