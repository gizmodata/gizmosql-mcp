# gizmosql-mcp

[![GitHub](https://img.shields.io/badge/GitHub-gizmodata%2Fgizmosql--mcp-blue.svg?logo=Github)](https://github.com/gizmodata/gizmosql-mcp)
[![npm](https://img.shields.io/badge/npm-@gizmodata%2Fgizmosql--mcp-red.svg?logo=npm)](https://www.npmjs.com/package/@gizmodata/gizmosql-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server and Claude Desktop
extension for [GizmoSQL](https://gizmosql.com), the Arrow Flight SQL server built on DuckDB.
It lets Claude Desktop, Claude Code and any other MCP client explore your schema and run
SQL against a GizmoSQL server you can reach from your machine (including private
networks over VPN).

Connectivity uses the official [`@gizmodata/gizmosql-client`](https://www.npmjs.com/package/@gizmodata/gizmosql-client)
and the native [GizmoSQL ADBC driver](https://github.com/gizmodata/gizmosql-adbc), which
the extension bundles for macOS (Apple Silicon and Intel), Linux (x64 and arm64) and
Windows x64.

## Tools

| Tool | What it does |
| --- | --- |
| `list_catalogs` | Catalogs (attached databases) visible to the user |
| `list_schemas(catalog?)` | Schemas, optionally in one catalog |
| `list_tables(catalog?, schema?, like?)` | Tables and views with their type; `like` is a SQL LIKE pattern |
| `describe_table(table, schema?, catalog?)` | Columns, types, nullability, constraints, estimated row count |
| `run_query(sql, params?, max_rows?)` | Runs a query; returns a Markdown table plus structured JSON, capped at `max_rows` |
| `explain_query(sql)` | DuckDB `EXPLAIN` plan without executing |
| `execute_statement(sql, params?)` | DML/DDL with affected-row count. Only registered when writes are enabled |
| `server_info()` | GizmoSQL/DuckDB versions, redacted connection URI, effective limits, extension version |
| `login_sso(wait_seconds?)` | Browser-based OAuth/SSO sign-in. Only registered when SSO is enabled |

It also exposes a resource template, `gizmosql://schema/{catalog}/{schema}/{table}`, that
returns the DDL of a table or view.

### Query parameters

`run_query` and `execute_statement` accept a `params` array bound positionally to `?` (or
`$1`, `$2`, ...) placeholders. Values travel to the server as typed Arrow data, never as
interpolated SQL text, so use placeholders for any literal that comes from user input or
from data returned by an earlier query.

- Plain JSON values: string, number, boolean, `null`. Strings in ISO-8601 date or timestamp
  form (`2024-01-02`, `2024-01-02T03:04:05Z`) are bound as timestamps.
- Explicit types: `{"type": "bigint", "value": "9223372036854775807"}`,
  `{"type": "string", "value": "2024-01-02"}` (keep a date-looking string as text),
  `{"type": "binary", "value": "<base64>"}`, plus `date`, `timestamp`, `number`,
  `boolean` and `null`.
- A placeholder whose type the server cannot infer from context, such as `SELECT ?`, must
  be cast: `SELECT ?::INTEGER`.

Example call:

```json
{
  "sql": "SELECT id, name FROM customers WHERE created_at >= ? AND region = ? LIMIT 20",
  "params": ["2024-01-01", "EMEA"]
}
```

## Installation

### Claude Desktop extension (`.mcpb`)

1. Download `gizmosql-mcp-<version>.mcpb` from the
   [GitHub Releases](https://github.com/gizmodata/gizmosql-mcp/releases) page. The `.sha256`
   file next to it lets you verify the download.
2. Either double-click the file, or in Claude Desktop open **Settings → Extensions →
   Advanced settings → Install Extension…** and pick the file.
3. Fill in the settings (host, port, credentials, limits). Credentials are marked sensitive
   and are stored in your operating system's keychain.
4. In a chat, open the **+** menu, choose **Connectors** and make sure **GizmoSQL** is
   turned on. Tools become available immediately.

No Node.js installation is needed: Claude Desktop runs the extension with its bundled
runtime (Node 24 in current builds), and the native driver for your platform is inside the
bundle.

### Claude Code

```bash
claude mcp add gizmosql \
  -e GIZMOSQL_HOST=gizmosql.internal.example.com \
  -e GIZMOSQL_PORT=31337 \
  -e GIZMOSQL_USERNAME=analyst \
  -e GIZMOSQL_PASSWORD='your-password' \
  -- npx -y @gizmodata/gizmosql-mcp
```

Use `-s user` to make it available in every project. Node.js 22 or newer is required
when running through `npx`; the client downloads the native driver for your platform on
first install.

### `claude_desktop_config.json` (manual JSON)

```json
{
  "mcpServers": {
    "gizmosql": {
      "command": "npx",
      "args": ["-y", "@gizmodata/gizmosql-mcp"],
      "env": {
        "GIZMOSQL_HOST": "gizmosql.internal.example.com",
        "GIZMOSQL_PORT": "31337",
        "GIZMOSQL_USERNAME": "analyst",
        "GIZMOSQL_PASSWORD": "your-password"
      }
    }
  }
}
```

### Streamable HTTP (remote connector)

The same server can listen over Streamable HTTP for MCP clients that connect over the
network, such as a Claude.ai custom connector:

```bash
GIZMOSQL_HOST=gizmosql.internal.example.com \
GIZMOSQL_USERNAME=analyst GIZMOSQL_PASSWORD='your-password' \
GIZMOSQL_MCP_BEARER_TOKEN='a-long-random-secret' \
npx -y @gizmodata/gizmosql-mcp --transport http --host 0.0.0.0 --port 3000
```

The MCP endpoint is `http://<host>:3000/mcp` (there is also `/healthz`). When
`GIZMOSQL_MCP_BEARER_TOKEN` is set, every request must send
`Authorization: Bearer <token>`; configure that header in the connector's request-header
settings. Put the server behind TLS (a reverse proxy) before exposing it beyond localhost.
OAuth for the MCP endpoint itself is not implemented yet; `transports.ts` has the single
`authorize()` hook where it would go.

## Configuration

All settings are environment variables. The extension's settings screen maps onto the
same names.

| Variable | Default | Description |
| --- | --- | --- |
| `GIZMOSQL_HOST` | required | Hostname or IP of the GizmoSQL server |
| `GIZMOSQL_PORT` | `31337` | Flight SQL port |
| `GIZMOSQL_USERNAME` / `GIZMOSQL_PASSWORD` | | Basic authentication |
| `GIZMOSQL_TOKEN` | | Bearer/JWT token authentication (alternative to username/password) |
| `GIZMOSQL_PLAINTEXT` | `false` | Connect without TLS (development servers only) |
| `GIZMOSQL_TLS_SKIP_VERIFY` | `false` | Accept self-signed or untrusted certificates |
| `GIZMOSQL_ALLOW_WRITES` | `false` | Register `execute_statement` and let `run_query` run non-read statements |
| `GIZMOSQL_MAX_ROWS` | `500` | Hard cap on rows returned by `run_query` |
| `GIZMOSQL_MAX_CELL_CHARS` | `200` | Cells longer than this are truncated with `…` |
| `GIZMOSQL_QUERY_TIMEOUT_SECONDS` | `60` | Per-statement timeout; `0` disables it |
| `GIZMOSQL_OAUTH_PORT` | `31339` | OAuth HTTP port used by `login_sso` |
| `GIZMOSQL_ENABLE_SSO` | `false` | Register the `login_sso` tool (credentials may then be left empty) |
| `GIZMOSQL_MCP_BEARER_TOKEN` | | HTTP transport only: required bearer token |

Exactly one authentication method must be configured: username and password, a token, or
SSO. `GIZMOSQL_DRIVER_LIB` can point at a custom `libadbc_driver_gizmosql` build if you
need one (see the client README).

## Read-only model and security

By default the server refuses anything that is not a read. `sql-guard.ts` classifies each
statement and only lets `SELECT`, `WITH … SELECT`, `FROM`, `VALUES`, `SHOW`, `DESCRIBE`,
`SUMMARIZE`, `EXPLAIN` and read-style `PRAGMA` through. CTEs that end in DML, `COPY`,
`ATTACH`, `INSTALL`, `LOAD`, `SET`, `CALL`, transactions and multi-statement input are all
rejected. Setting `GIZMOSQL_ALLOW_WRITES=true` lifts that restriction and adds
`execute_statement`, which is annotated as destructive so clients ask before running it.

Treat the guard as defense in depth, not as the security boundary. The real boundary is
the privileges of the GizmoSQL user the server connects as:

- With username/password authentication every session has the `admin` role in GizmoSQL.
- With [token authentication](https://docs.gizmosql.com/token_authentication/) the JWT's
  `role` claim (or the server's `--token-default-role`) decides the role, and GizmoSQL's
  built-in `readonly` role only permits `SELECT` queries. Mint a token with
  `role: readonly` (for example with
  [`generate-gizmosql-token`](https://docs.gizmosql.com/token_authentication/)) and set
  `GIZMOSQL_TOKEN`. GizmoSQL Enterprise adds per-catalog read/write/none permissions in the
  token as well. See the [security guide](https://docs.gizmosql.com/security/).

Other guarantees:

- Credentials never appear in tool output, `server_info` or error messages; every message
  that reaches the client is redacted.
- The row cap is enforced by the server: reads are executed as
  `SELECT * FROM (<your query>) LIMIT max_rows + 1`, never by fetching everything and
  slicing (statements that cannot be wrapped, such as `PRAGMA`, are sliced).
- The timeout is enforced by the server too, via `SET gizmosql.query_timeout` on the
  session, with a client-side deadline a few seconds later as a backstop. When the
  backstop fires the connection is closed, which cancels the statement, and reopened on
  the next call.
- One connection per process, opened lazily and reconnected once after a connection-level
  failure. The server has no tools that touch the local filesystem or any network endpoint
  other than the configured GizmoSQL host (and, for `login_sso`, its OAuth endpoint).

## Troubleshooting

**TLS errors (`certificate verify failed`, `x509`, `unknown authority`).** GizmoSQL uses
TLS by default. For servers with self-signed certificates enable **Skip TLS certificate
verification** (`GIZMOSQL_TLS_SKIP_VERIFY=true`). For servers started without TLS enable
**Plaintext** (`GIZMOSQL_PLAINTEXT=true`) instead.

**`connection refused` / `Unavailable` / timeouts to a `10.x`, `172.16.x` or `192.168.x`
address.** The extension runs on your machine and connects directly, so you must be on the
same network as the server. Connect your VPN first, then start a new chat. Check with
`nc -vz <host> 31337` from a terminal.

**Port-forward setups.** If the server is only reachable through SSH or Kubernetes, forward
the port locally and point the extension at `localhost`:

```bash
ssh -N -L 31337:gizmosql.internal:31337 bastion.example.com
kubectl port-forward svc/gizmosql 31337:31337
```

TLS still works through the tunnel; the certificate is validated against the hostname you
connect to, so you may need `GIZMOSQL_TLS_SKIP_VERIFY=true` when the certificate was issued
for the internal name.

**Authentication failures.** `server_info` shows the user and auth method the server is
using. Basic auth needs both username and password; token auth uses only
`GIZMOSQL_TOKEN`. With SSO, run `login_sso` first.

**Tools do not appear in the chat.** Open the **+** menu in the chat, choose Connectors and
enable GizmoSQL. After changing settings, start a new chat.

**"No bundled GizmoSQL ADBC driver for this platform".** The `.mcpb` bundles drivers for
darwin-arm64, darwin-x64, linux-x64, linux-arm64 and win32-x64. Windows on ARM is not
supported yet because the ADBC driver manager has no arm64 build.

**Logs.** Claude Desktop writes the server's stderr to
`~/Library/Logs/Claude/mcp-server-gizmosql.log` on macOS and `%APPDATA%\Claude\logs\` on
Windows. Native driver messages appear there as JSON lines.

**`npx` install did not download the driver.** npm 11.19+ asks you to approve install
scripts: run `npm install-scripts approve @gizmodata/gizmosql-client` in the project, or
re-run `node node_modules/@gizmodata/gizmosql-client/scripts/download-driver.cjs`.

## Development

```bash
npm install
npm run build          # compile to dist/
npm test               # unit tests (node:test)
npm run test:integration   # starts gizmodata/gizmosql:v1.38.1 in Docker (skips without Docker)
npm run lint           # eslint --fix
npm run typecheck
npm run build:mcpb     # build/gizmosql-mcp-<version>.mcpb + .sha256
```

Run the server locally against a container:

```bash
docker run --name gizmosql --detach --tty --init --publish 31337:31337 \
  --env TLS_ENABLED=1 --env GIZMOSQL_USERNAME=gizmosql --env GIZMOSQL_PASSWORD=gizmosql_password \
  gizmodata/gizmosql:v1.38.1

GIZMOSQL_HOST=localhost GIZMOSQL_USERNAME=gizmosql GIZMOSQL_PASSWORD=gizmosql_password \
GIZMOSQL_TLS_SKIP_VERIFY=true node dist/cli.js
```

The integration tests can target an existing server instead of Docker with
`GIZMOSQL_TEST_HOST`, `GIZMOSQL_TEST_PORT`, `GIZMOSQL_TEST_USERNAME` and
`GIZMOSQL_TEST_PASSWORD` (TLS with an untrusted certificate is assumed).

### Releasing

1. Move the `[Unreleased]` entries in `CHANGELOG.md` into a new `## [X.Y.Z] - YYYY-MM-DD`
   section and set the same version in `package.json` and `manifest.json`.
2. Commit, tag `vX.Y.Z`, and push: `git push origin main vX.Y.Z`.
3. The release workflow runs the tests, builds the `.mcpb`, creates a GitHub Release with
   the bundle, its checksum and the npm tarball (release notes come from the CHANGELOG
   section), and publishes `@gizmodata/gizmosql-mcp` to npm.

See [NOTES.md](NOTES.md) for implementation notes, known limitations and follow-ups.

## Privacy Policy

This extension runs entirely on your computer and talks only to the GizmoSQL server you
configure (and, when you use `login_sso`, that server's OAuth endpoint and your identity
provider in your browser).

- **Data collection.** The extension collects nothing. It does not send telemetry,
  analytics or crash reports to GizmoData or anyone else.
- **Usage and storage.** The SQL your MCP client sends and the rows the server returns
  pass through the extension in memory and are handed back to the client; nothing is
  written to disk. Connection settings are stored by Claude Desktop; credentials marked
  sensitive are kept in your operating system's keychain. An SSO identity token is held
  in process memory only and discarded when the extension exits.
- **Third-party sharing.** Data is shared only with the GizmoSQL server you configured.
  What your MCP client (for example Claude) does with tool results is governed by that
  client's own privacy policy.
- **Data retention.** The extension retains no data between runs. Your GizmoSQL server
  may log queries according to its own configuration.
- **Contact.** privacy questions: info@gizmodata.com. GizmoData's general privacy policy is
  at <https://gizmodata.com/privacy-policy>.

## License

Apache License 2.0
