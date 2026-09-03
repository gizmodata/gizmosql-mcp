// Transport-agnostic MCP server: tool + resource definitions for GizmoSQL.

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GizmoConnection, QueryTimeoutError, redactedUri, type McpConfig } from "./connection.js";
import {
  cellToJson,
  cellToText,
  escapeMarkdownCell,
  formatTable,
  resultFooter,
  toMarkdownTable,
  truncateText,
} from "./format.js";
import { convertParams, paramsSchema, PARAMS_DESCRIPTION, ParameterError } from "./params.js";
import { runSsoLogin } from "./sso.js";
import {
  guardStatement,
  normalizeStatement,
  SqlGuardError,
  WRAPPER_ALIAS,
  wrapWithLimit,
} from "./sql-guard.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export interface ServerContext {
  connection: GizmoConnection;
  config: McpConfig;
  transport: "stdio" | "http";
}

const SERVER_INSTRUCTIONS =
  "GizmoSQL is an Arrow Flight SQL server built on DuckDB, so DuckDB SQL syntax and functions apply. " +
  "Start with list_catalogs / list_schemas / list_tables / describe_table to discover the schema, then " +
  "use run_query for SELECT queries. Results are capped at a configurable number of rows; use LIMIT, " +
  "aggregation, or WHERE filters to keep results small. Bind user-supplied literals with ? placeholders " +
  "and the params argument instead of interpolating them into SQL. Unless GIZMOSQL_ALLOW_WRITES is " +
  "enabled the server is read-only. Unqualified table names resolve against the session's current " +
  "catalog and schema (see server_info); use use_schema or fully qualified names to work elsewhere.";

function text(body: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text: body }] };
  if (structured) result.structuredContent = structured;
  return result;
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Converts a thrown error into a redacted, user-facing message. */
export function describeError(err: unknown, connection: GizmoConnection): string {
  if (err instanceof SqlGuardError || err instanceof ParameterError || err instanceof QueryTimeoutError) {
    return connection.redact(err.message);
  }
  const raw = err instanceof Error ? err.message : String(err);
  // Surface the server's message verbatim (minus credentials); strip the
  // client's generic prefix so the DuckDB error is front and center.
  const cleaned = raw.replace(/^Failed to execute (?:query|update): /u, "");
  return connection.redact(cleaned);
}

const sqlArg = z.string().min(1).describe("A single SQL statement (DuckDB dialect).");

/** Identifier quoting for generated SQL (used only for DDL synthesis). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface TableRef {
  catalog: string;
  schema: string;
  table: string;
}

/** Table/view DDL from DuckDB's catalog functions, or synthesized from information_schema. */
async function fetchDdl(connection: GizmoConnection, ref: TableRef): Promise<string | null> {
  const fromTables = await connection.query(
    "SELECT sql FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?",
    [ref.catalog, ref.schema, ref.table],
  );
  if (fromTables.numRows > 0) {
    const sql = fromTables.getChildAt(0)?.get(0);
    if (typeof sql === "string" && sql.trim()) return sql;
  }
  const fromViews = await connection.query(
    "SELECT sql FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND view_name = ?",
    [ref.catalog, ref.schema, ref.table],
  );
  if (fromViews.numRows > 0) {
    const sql = fromViews.getChildAt(0)?.get(0);
    if (typeof sql === "string" && sql.trim()) return sql;
  }
  const cols = await connection.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns " +
      "WHERE table_catalog = ? AND table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    [ref.catalog, ref.schema, ref.table],
  );
  if (cols.numRows === 0) return null;
  const lines: string[] = [];
  for (let i = 0; i < cols.numRows; i++) {
    const name = String(cols.getChildAt(0)?.get(i));
    const type = String(cols.getChildAt(1)?.get(i));
    const nullable = String(cols.getChildAt(2)?.get(i)) !== "NO";
    lines.push(`  ${quoteIdent(name)} ${type}${nullable ? "" : " NOT NULL"}`);
  }
  return `CREATE TABLE ${quoteIdent(ref.catalog)}.${quoteIdent(ref.schema)}.${quoteIdent(ref.table)} (\n${lines.join(",\n")}\n);`;
}

/** Builds the McpServer with every tool/resource registered against `ctx`. */
export function createServer(ctx: ServerContext): McpServer {
  const { connection, config } = ctx;
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** Wraps a tool body so every failure becomes a redacted isError result. */
  const tool = <T>(fn: (args: T) => Promise<CallToolResult>) => {
    return async (args: T): Promise<CallToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return errorResult(describeError(err, connection));
      }
    };
  };

  server.registerTool(
    "list_catalogs",
    {
      title: "List catalogs",
      description: "Lists the catalogs (attached databases) visible to the connected GizmoSQL user.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async () => {
      const catalogs = await connection.run((c) => c.getCatalogs());
      const body = catalogs.length
        ? catalogs.map((c) => `- ${c}`).join("\n")
        : "(no catalogs visible)";
      return text(body, { catalogs });
    }),
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description: "Lists schemas, optionally filtered to one catalog.",
      inputSchema: {
        catalog: z.string().optional().describe("Catalog name to filter by (exact match)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async ({ catalog }) => {
      const schemas = await connection.run((c) => c.getSchemas(catalog));
      const rows = schemas.map((s) => [escapeMarkdownCell(s.catalog), escapeMarkdownCell(s.schema)]);
      const body = rows.length ? toMarkdownTable(["catalog", "schema"], rows) : "(no schemas found)";
      return text(body, { schemas });
    }),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "Lists tables and views with their type. Filters are optional; `like` is a SQL LIKE pattern " +
        "on the table name (e.g. 'orders%').",
      inputSchema: {
        catalog: z.string().optional().describe("Catalog name (exact match)."),
        schema: z.string().optional().describe("Schema name (SQL LIKE pattern, e.g. 'main')."),
        like: z.string().optional().describe("Table-name LIKE pattern, e.g. 'cust%'."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async ({ catalog, schema, like }) => {
      const tables = await connection.run((c) => c.getTables(catalog, schema, like));
      const rows = tables.map((t) => [
        escapeMarkdownCell(t.catalog),
        escapeMarkdownCell(t.schema),
        escapeMarkdownCell(t.tableName),
        escapeMarkdownCell(t.tableType),
      ]);
      const body = rows.length
        ? toMarkdownTable(["catalog", "schema", "table", "type"], rows)
        : "(no tables matched)";
      return text(body, { tables });
    }),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Describes a table or view: columns with types and nullability, constraints, and an " +
        "estimated row count when it is cheap to obtain. Provide schema/catalog when the table " +
        "name is ambiguous.",
      inputSchema: {
        table: z.string().min(1).describe("Table or view name (exact match)."),
        schema: z.string().optional().describe("Schema name (exact match)."),
        catalog: z.string().optional().describe("Catalog name (exact match)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async ({ table, schema, catalog }) => {
      const filters: string[] = ["table_name = ?"];
      const params: Array<string> = [table];
      if (schema !== undefined) {
        filters.push("table_schema = ?");
        params.push(schema);
      }
      if (catalog !== undefined) {
        filters.push("table_catalog = ?");
        params.push(catalog);
      }
      const columns = await connection.query(
        "SELECT table_catalog, table_schema, table_name, column_name, data_type, is_nullable, column_default " +
          `FROM information_schema.columns WHERE ${filters.join(" AND ")} ORDER BY table_catalog, table_schema, ordinal_position`,
        params,
      );
      if (columns.numRows === 0) {
        return errorResult(
          `Table "${table}" not found${schema ? ` in schema "${schema}"` : ""}${catalog ? ` (catalog "${catalog}")` : ""}. ` +
            "Use list_tables to find the exact name.",
        );
      }
      const locations = new Set<string>();
      for (let i = 0; i < columns.numRows; i++) {
        locations.add(`${columns.getChildAt(0)?.get(i)}.${columns.getChildAt(1)?.get(i)}`);
      }
      if (locations.size > 1) {
        return errorResult(
          `Table "${table}" exists in multiple locations: ${[...locations].join(", ")}. ` +
            "Pass schema (and catalog) to disambiguate.",
        );
      }
      const ref: TableRef = {
        catalog: String(columns.getChildAt(0)?.get(0)),
        schema: String(columns.getChildAt(1)?.get(0)),
        table,
      };

      const colRows: string[][] = [];
      const colJson: Array<Record<string, unknown>> = [];
      for (let i = 0; i < columns.numRows; i++) {
        const name = String(columns.getChildAt(3)?.get(i));
        const type = String(columns.getChildAt(4)?.get(i));
        const nullable = String(columns.getChildAt(5)?.get(i)) === "YES";
        const def = columns.getChildAt(6)?.get(i);
        colRows.push([
          escapeMarkdownCell(name),
          escapeMarkdownCell(type),
          nullable ? "YES" : "NO",
          escapeMarkdownCell(def === null || def === undefined ? "" : String(def)),
        ]);
        colJson.push({ name, type, nullable, default: def === undefined ? null : def });
      }

      const meta = await connection.query(
        "SELECT 'BASE TABLE' AS kind, estimated_size FROM duckdb_tables() " +
          "WHERE database_name = ? AND schema_name = ? AND table_name = ? " +
          "UNION ALL SELECT 'VIEW', NULL FROM duckdb_views() " +
          "WHERE database_name = ? AND schema_name = ? AND view_name = ?",
        [ref.catalog, ref.schema, ref.table, ref.catalog, ref.schema, ref.table],
      );
      let kind = "TABLE";
      let estimatedRows: number | null = null;
      if (meta.numRows > 0) {
        kind = String(meta.getChildAt(0)?.get(0));
        const est = meta.getChildAt(1)?.get(0);
        if (est !== null && est !== undefined) estimatedRows = Number(est);
      }

      const constraints = await connection.query(
        "SELECT constraint_type, constraint_column_names, constraint_text FROM duckdb_constraints() " +
          "WHERE database_name = ? AND schema_name = ? AND table_name = ? " +
          "AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK') " +
          "ORDER BY constraint_index",
        [ref.catalog, ref.schema, ref.table],
      );
      const constraintJson: Array<{ type: string; columns: unknown; text: string }> = [];
      const constraintLines: string[] = [];
      for (let i = 0; i < constraints.numRows; i++) {
        const type = String(constraints.getChildAt(0)?.get(i));
        const cols = cellToJson(constraints.getChildAt(1)?.get(i), constraints.schema.fields[1].type);
        const ctext = String(constraints.getChildAt(2)?.get(i) ?? "");
        constraintJson.push({ type, columns: cols, text: ctext });
        constraintLines.push(`- ${type}: ${ctext || cellToText(cols)}`);
      }

      const header = `**${ref.catalog}.${ref.schema}.${ref.table}** (${kind})` +
        (estimatedRows !== null ? ` · estimated rows: ${estimatedRows}` : "");
      const parts = [header, "", toMarkdownTable(["column", "type", "nullable", "default"], colRows)];
      if (constraintLines.length) parts.push("", "Constraints:", ...constraintLines);
      return text(parts.join("\n"), {
        catalog: ref.catalog,
        schema: ref.schema,
        table: ref.table,
        kind,
        estimated_rows: estimatedRows,
        columns: colJson,
        constraints: constraintJson,
      });
    }),
  );

  server.registerTool(
    "use_schema",
    {
      title: "Set default catalog/schema",
      description:
        "Sets the session's default catalog and/or schema (DuckDB USE) so unqualified table names " +
        "resolve there for the rest of the session. Does not read or modify data.",
      inputSchema: {
        catalog: z.string().optional().describe("Catalog (database) name."),
        schema: z.string().optional().describe("Schema name within the catalog."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async ({ catalog, schema }) => {
      if (!catalog && !schema) return errorResult("Provide a catalog and/or a schema.");
      await connection.useSchema({ catalog, schema });
      const t = await connection.query("SELECT current_catalog() AS c, current_schema() AS s");
      const current = { catalog: String(t.getChildAt(0)?.get(0)), schema: String(t.getChildAt(1)?.get(0)) };
      return text(`Default set to ${current.catalog}.${current.schema} for this session.`, current);
    }),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run query",
      description:
        "Runs a SQL query against GizmoSQL (DuckDB dialect) and returns the rows as a Markdown table " +
        `plus structured JSON. Results are capped at max_rows (default ${config.maxRows}, hard maximum ` +
        `${config.maxRows}); long cells are truncated to ${config.maxCellChars} characters with …. ` +
        (config.allowWrites
          ? "Writes are enabled on this server; prefer execute_statement for DML/DDL."
          : "This server is read-only: only SELECT/WITH/SHOW/DESCRIBE/SUMMARIZE/EXPLAIN/PRAGMA(read) statements are accepted."),
      inputSchema: {
        sql: sqlArg,
        params: paramsSchema.optional().describe(PARAMS_DESCRIPTION),
        max_rows: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Row cap for this call (1..${config.maxRows}; default ${config.maxRows}).`),
      },
      outputSchema: {
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        rows: z.array(z.array(z.unknown())),
        row_count: z.number(),
        truncated: z.boolean(),
        elapsed_ms: z.number(),
      },
      annotations: { readOnlyHint: !config.allowWrites, idempotentHint: !config.allowWrites },
    },
    tool(async ({ sql, params, max_rows }) => {
      const guarded = guardStatement(sql, config.allowWrites);
      const maxRows = Math.min(max_rows ?? config.maxRows, config.maxRows);
      const bound = convertParams(params);
      const effectiveSql = guarded.classification.wrappable
        ? wrapWithLimit(guarded.sql, maxRows + 1)
        : guarded.sql;
      const started = Date.now();
      let capped;
      try {
        capped = await connection.queryCapped(effectiveSql, bound, maxRows);
      } catch (err) {
        if (guarded.classification.wrappable && !(err instanceof QueryTimeoutError)) {
          throw new Error(
            `${describeError(err, connection)}\n(Note: to enforce max_rows the query was executed as ` +
              `SELECT * FROM (<your query>) AS ${WRAPPER_ALIAS} LIMIT ${maxRows + 1}, so line numbers in the ` +
              "server's message are offset by one.)",
          );
        }
        throw err;
      }
      const elapsedMs = Date.now() - started;
      const formatted = formatTable(capped.table, { maxRows, maxCellChars: config.maxCellChars });
      const truncated = formatted.truncated || capped.truncated;
      const footer = resultFooter({
        rowCount: formatted.rowCount,
        truncated,
        maxRows,
        elapsedMs,
      });
      const body = formatted.rowCount > 0 ? `${formatted.markdown}\n\n${footer}` : `(no rows)\n\n${footer}`;
      return text(body, {
        columns: formatted.columns,
        rows: formatted.rows,
        row_count: formatted.rowCount,
        truncated,
        elapsed_ms: elapsedMs,
      });
    }),
  );

  server.registerTool(
    "explain_query",
    {
      title: "Explain query",
      description:
        "Returns DuckDB's EXPLAIN output (the physical plan) for a SQL statement without executing it.",
      inputSchema: { sql: sqlArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async ({ sql }) => {
      const guarded = guardStatement(sql, config.allowWrites);
      const normalized = normalizeStatement(guarded.sql);
      const explainSql = /^\s*EXPLAIN\b/iu.test(normalized) ? normalized : `EXPLAIN ${normalized}`;
      const table = await connection.query(explainSql);
      const sections: string[] = [];
      const keyCol = table.schema.fields.findIndex((f) => f.name === "explain_key");
      const valCol = table.schema.fields.findIndex((f) => f.name === "explain_value");
      for (let i = 0; i < table.numRows; i++) {
        const key = keyCol >= 0 ? String(table.getChildAt(keyCol)?.get(i)) : `row ${i + 1}`;
        const value = valCol >= 0
          ? String(table.getChildAt(valCol)?.get(i) ?? "")
          : table.schema.fields.map((_, c) => String(table.getChildAt(c)?.get(i))).join(" ");
        sections.push(`### ${key}\n\`\`\`\n${value.replace(/\s+$/u, "")}\n\`\`\``);
      }
      return text(sections.join("\n\n") || "(no plan returned)");
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "execute_statement",
      {
        title: "Execute statement",
        description:
          "Executes a DML/DDL statement (INSERT/UPDATE/DELETE/CREATE/...) with optional bound parameters " +
          "and returns the affected-row count (-1 when the server does not report one).",
        inputSchema: {
          sql: sqlArg,
          params: paramsSchema.optional().describe(PARAMS_DESCRIPTION),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      tool(async ({ sql, params }) => {
        const guarded = guardStatement(sql, true);
        const bound = convertParams(params);
        const started = Date.now();
        const affected = await connection.update(guarded.sql, bound);
        const elapsedMs = Date.now() - started;
        const count = affected < 0 ? "unknown" : String(affected);
        return text(`Statement executed. Affected rows: ${count} · ${elapsedMs} ms`, {
          affected_rows: affected,
          elapsed_ms: elapsedMs,
        });
      }),
    );
  }

  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description:
        "Reports the GizmoSQL and DuckDB versions, the connection (credentials redacted), the " +
        "effective limits, and this MCP server's version.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    tool(async () => {
      let gizmosqlVersion = "unknown";
      let duckdbVersion = "unknown";
      let user = "unknown";
      let currentCatalog = "unknown";
      let currentSchema = "unknown";
      try {
        const t = await connection.query(
          "SELECT GIZMOSQL_VERSION() AS gv, version() AS dv, GIZMOSQL_USER() AS u, current_catalog() AS c, current_schema() AS s",
        );
        gizmosqlVersion = String(t.getChildAt(0)?.get(0));
        duckdbVersion = String(t.getChildAt(1)?.get(0));
        user = String(t.getChildAt(2)?.get(0));
        currentCatalog = String(t.getChildAt(3)?.get(0));
        currentSchema = String(t.getChildAt(4)?.get(0));
      } catch {
        // Older servers lack GIZMOSQL_VERSION(); fall back to Flight SQL SqlInfo.
        try {
          const info = await connection.run((c) => c.getSqlInfo([0, 1]));
          duckdbVersion = String(info.get(1) ?? "unknown");
          gizmosqlVersion = `${info.get(0) ?? "gizmosql"} (version not reported)`;
        } catch {
          // leave unknowns
        }
      }
      const auth = connection.effectiveAuth();
      const info = {
        gizmosql_version: gizmosqlVersion,
        duckdb_version: duckdbVersion,
        connection_uri: redactedUri(config, auth.user),
        auth_method: auth.method,
        user,
        tls: !config.plaintext,
        tls_skip_verify: config.tlsSkipVerify,
        current_catalog: currentCatalog,
        current_schema: currentSchema,
        allow_writes: config.allowWrites,
        max_rows: config.maxRows,
        max_cell_chars: config.maxCellChars,
        query_timeout_seconds: config.queryTimeoutSeconds,
        default_catalog: connection.currentSearchPath().catalog ?? null,
        default_schema: connection.currentSearchPath().schema ?? null,
        transport: ctx.transport,
        mcp_server: `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
        session_warnings: connection.sessionWarnings(),
      };
      const lines = Object.entries(info).map(
        ([k, v]) => `- ${k}: ${Array.isArray(v) ? (v.length ? v.join("; ") : "none") : v === null ? "(not set)" : String(v)}`,
      );
      return text(lines.join("\n"), info);
    }),
  );

  if (config.enableSso) {
    server.registerTool(
      "login_sso",
      {
        title: "Sign in with SSO",
        description:
          "Signs in to GizmoSQL with the server's OAuth/SSO identity provider: opens the provider's " +
          "login page in your browser, waits for you to finish, then reconnects with the identity " +
          "token (kept in memory only). If the wait times out, call login_sso again to keep waiting.",
        inputSchema: {
          wait_seconds: z
            .number()
            .int()
            .min(5)
            .max(600)
            .optional()
            .describe("How long to wait for the browser login before returning (default 90)."),
        },
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      },
      tool(async ({ wait_seconds }) => {
        const outcome = await runSsoLogin(connection, { waitSeconds: wait_seconds ?? 90 });
        return text(outcome.message, { status: outcome.status, auth_url: outcome.authUrl ?? null });
      }),
    );
  }

  server.registerResource(
    "table_schema",
    new ResourceTemplate("gizmosql://schema/{catalog}/{schema}/{table}", {
      list: async () => {
        const tables = await connection.run((c) => c.getTables());
        return {
          resources: tables.slice(0, 500).map((t) => ({
            uri: `gizmosql://schema/${encodeURIComponent(t.catalog)}/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.tableName)}`,
            name: `${t.catalog}.${t.schema}.${t.tableName}`,
            // Clients (e.g. Claude Desktop's resource picker) display `title`;
            // without it they fall back to the template's title for every entry.
            title: `${t.catalog}.${t.schema}.${t.tableName}`,
            description: `DDL of ${t.tableType.toLowerCase()} ${t.catalog}.${t.schema}.${t.tableName}`,
            mimeType: "text/plain",
          })),
        };
      },
    }),
    {
      title: "Table DDL",
      description: "CREATE statement (DDL) for a table or view: gizmosql://schema/{catalog}/{schema}/{table}",
      mimeType: "text/plain",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const pick = (v: string | string[] | undefined) => decodeURIComponent(Array.isArray(v) ? v[0] : (v ?? ""));
      const ref: TableRef = {
        catalog: pick(variables.catalog),
        schema: pick(variables.schema),
        table: pick(variables.table),
      };
      try {
        const ddl = await fetchDdl(connection, ref);
        const body = ddl ?? `-- ${ref.catalog}.${ref.schema}.${ref.table} not found`;
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: truncateText(body, 100000) }] };
      } catch (err) {
        return {
          contents: [{ uri: uri.href, mimeType: "text/plain", text: `-- error: ${describeError(err, connection)}` }],
        };
      }
    },
  );

  return server;
}
