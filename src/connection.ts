// Configuration parsing, credential redaction, and the single lazily
// opened FlightSQLClient shared by the whole server process.

import { FlightSQLClient, QueryCancelledError, type SqlParameters } from "@gizmodata/gizmosql-client";
import { Table, type RecordBatch } from "apache-arrow";

export type AuthMethod = "password" | "none";

/** Settings for one GizmoSQL server. */
export interface ConnectionConfig {
  /** Unique, case-insensitive name used in tool arguments (e.g. "default", "prod"). */
  name: string;
  host: string;
  port: number;
  /**
   * Username for basic authentication. GizmoSQL's JWT/SSO scheme uses the
   * username `token` with the JWT as the password, so no separate bearer
   * option exists here.
   */
  username?: string;
  password?: string;
  plaintext: boolean;
  tlsSkipVerify: boolean;
  oauthPort: number;
  /** Catalog to `USE` at session start (optional). */
  defaultCatalog?: string;
  /** Schema to `USE` at session start (optional). */
  defaultSchema?: string;
  /** Per-statement timeout applied to this connection's sessions (0 = none). */
  queryTimeoutSeconds: number;
}

/** Whole-server settings plus every configured connection (the first is the initial default). */
export interface McpConfig {
  connections: ConnectionConfig[];
  allowWrites: boolean;
  maxRows: number;
  maxCellChars: number;
  queryTimeoutSeconds: number;
  /** Bearer token required on every Streamable HTTP request (http transport only). */
  mcpBearerToken?: string;
  /** Enables the optional `login_sso` tool (OAuth/SSO browser flow). */
  enableSso: boolean;
}

export const DEFAULTS = {
  port: 31337,
  oauthPort: 31339,
  maxRows: 500,
  maxCellChars: 200,
  queryTimeoutSeconds: 60,
  connectionName: "default",
} as const;

/** Extra connection slots the Claude Desktop manifest exposes (`GIZMOSQL_2_*`, `GIZMOSQL_3_*`). */
export const MANIFEST_SLOTS = ["2", "3"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);

/**
 * Unsubstituted MCPB template placeholders. Claude Desktop passes the
 * literal `${user_config.<key>}` for optional settings the user left
 * blank, which must count as "not set".
 */
const TEMPLATE_PLACEHOLDER = /^\$\{[^}]*\}$/u;

/** True when an env value should be treated as absent. */
export function isUnset(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim();
  return v === "" || TEMPLATE_PLACEHOLDER.test(v);
}

export function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (isUnset(raw)) return fallback;
  const v = raw!.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new ConfigError(`${name} must be true/false (got "${raw}").`);
}

export function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max?: number },
): number {
  if (isUnset(raw)) return fallback;
  const n = Number(raw!.trim());
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(`${name} must be an integer ${range} (got "${raw}").`);
  }
  return n;
}

function nonEmpty(raw: string | undefined): string | undefined {
  return isUnset(raw) ? undefined : raw!.trim();
}

/** Env-variable key fragment for a connection key: `prod-eu` -> `PROD_EU`. */
export function envKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
}

/**
 * Parses one connection from `env` using variables named `<prefix>HOST`,
 * `<prefix>USERNAME`, ... (prefix `GIZMOSQL_` for the primary connection,
 * `GIZMOSQL_<KEY>_` for additional ones). Returns null when no host is set.
 */
function parseConnection(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaultName: string,
  globals: { queryTimeoutSeconds: number; enableSso: boolean },
): ConnectionConfig | null {
  const v = (suffix: string) => env[`${prefix}${suffix}`];
  const host = nonEmpty(v("HOST"));
  if (!host) return null;
  const label = `${prefix}HOST`;
  const name = nonEmpty(v("NAME")) ?? defaultName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
    throw new ConfigError(
      `Connection name "${name}" (${prefix}NAME) must be 1-64 letters, digits, dots, dashes or underscores.`,
    );
  }
  const username = nonEmpty(v("USERNAME"));
  const rawPassword = v("PASSWORD");
  const password = isUnset(rawPassword) && rawPassword !== "" ? undefined : rawPassword;

  const hasPassword = username !== undefined || (password !== undefined && password !== "");
  if (hasPassword && (username === undefined || password === undefined)) {
    throw new ConfigError(`Connection "${name}": ${prefix}USERNAME and ${prefix}PASSWORD must be set together.`);
  }
  if (!hasPassword && !globals.enableSso) {
    throw new ConfigError(
      `Connection "${name}" (${label}) has no credentials: set ${prefix}USERNAME + ${prefix}PASSWORD ` +
        `(for a GizmoSQL JWT use username "token" and the JWT as the password), or GIZMOSQL_ENABLE_SSO=true ` +
        "to sign in with the login_sso tool.",
    );
  }
  return {
    name,
    host,
    port: parseInteger(`${prefix}PORT`, v("PORT"), DEFAULTS.port, { min: 1, max: 65535 }),
    username: hasPassword ? username : undefined,
    password: hasPassword ? password : undefined,
    plaintext: parseBoolean(`${prefix}PLAINTEXT`, v("PLAINTEXT"), false),
    tlsSkipVerify: parseBoolean(`${prefix}TLS_SKIP_VERIFY`, v("TLS_SKIP_VERIFY"), false),
    oauthPort: parseInteger(`${prefix}OAUTH_PORT`, v("OAUTH_PORT"), DEFAULTS.oauthPort, { min: 1, max: 65535 }),
    defaultCatalog: nonEmpty(v("DEFAULT_CATALOG")),
    defaultSchema: nonEmpty(v("DEFAULT_SCHEMA")),
    queryTimeoutSeconds: globals.queryTimeoutSeconds,
  };
}

/**
 * Builds the effective configuration from environment variables.
 *
 * Connections:
 * - primary: `GIZMOSQL_HOST` etc. (name `GIZMOSQL_CONNECTION_NAME`, default "default");
 * - manifest slots: `GIZMOSQL_2_HOST` / `GIZMOSQL_3_HOST` etc. (names `GIZMOSQL_2_NAME`,
 *   default "server2"/"server3");
 * - any names listed in `GIZMOSQL_CONNECTIONS` (comma separated), read from
 *   `GIZMOSQL_<NAME>_HOST` etc. with the name upper-cased and non-alphanumerics
 *   replaced by `_`.
 * Slots without a host are ignored. At least one connection is required.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const enableSso = parseBoolean("GIZMOSQL_ENABLE_SSO", env.GIZMOSQL_ENABLE_SSO, false);
  const queryTimeoutSeconds = parseInteger(
    "GIZMOSQL_QUERY_TIMEOUT_SECONDS",
    env.GIZMOSQL_QUERY_TIMEOUT_SECONDS,
    DEFAULTS.queryTimeoutSeconds,
    { min: 0, max: 86400 },
  );
  const globals = { queryTimeoutSeconds, enableSso };

  const connections: ConnectionConfig[] = [];
  const primary = parseConnection(
    env,
    "GIZMOSQL_",
    nonEmpty(env.GIZMOSQL_CONNECTION_NAME) ?? DEFAULTS.connectionName,
    globals,
  );
  if (primary) connections.push(primary);

  const extraKeys: Array<{ key: string; defaultName: string }> = MANIFEST_SLOTS.map((slot) => ({
    key: slot,
    defaultName: `server${slot}`,
  }));
  for (const listed of (nonEmpty(env.GIZMOSQL_CONNECTIONS) ?? "").split(",")) {
    const key = listed.trim();
    if (key) extraKeys.push({ key: envKey(key), defaultName: key.toLowerCase() });
  }
  for (const { key, defaultName } of extraKeys) {
    const c = parseConnection(env, `GIZMOSQL_${key}_`, defaultName, globals);
    if (c) connections.push(c);
  }

  if (connections.length === 0) {
    throw new ConfigError("GIZMOSQL_HOST is required (hostname or IP of the GizmoSQL server).");
  }
  const seen = new Map<string, string>();
  for (const c of connections) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) {
      throw new ConfigError(`Connection name "${c.name}" is used more than once (names are case-insensitive).`);
    }
    seen.set(k, c.name);
  }

  return {
    connections,
    allowWrites: parseBoolean("GIZMOSQL_ALLOW_WRITES", env.GIZMOSQL_ALLOW_WRITES, false),
    maxRows: parseInteger("GIZMOSQL_MAX_ROWS", env.GIZMOSQL_MAX_ROWS, DEFAULTS.maxRows, { min: 1, max: 100000 }),
    maxCellChars: parseInteger("GIZMOSQL_MAX_CELL_CHARS", env.GIZMOSQL_MAX_CELL_CHARS, DEFAULTS.maxCellChars, {
      min: 1,
      max: 100000,
    }),
    queryTimeoutSeconds,
    mcpBearerToken: nonEmpty(env.GIZMOSQL_MCP_BEARER_TOKEN),
    enableSso,
  };
}

export function authMethod(config: Pick<ConnectionConfig, "username" | "password">): AuthMethod {
  if (config.username !== undefined) return "password";
  return "none";
}

/** Connection URI with the password never included. */
export function redactedUri(config: ConnectionConfig, overrideUser?: string): string {
  const user = overrideUser ?? config.username;
  const cred = user ? `${encodeURIComponent(user)}:***@` : "";
  const transport = config.plaintext ? "?transport=tcp" : "";
  return `gizmosql://${cred}${config.host}:${config.port}${transport}`;
}

/** Replaces every configured secret in `text` with `***`. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length === 0) continue;
    out = out.split(s).join("***");
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join("***");
  }
  return out;
}

export class QueryTimeoutError extends Error {
  constructor(seconds: number) {
    super(
      `Query exceeded the ${seconds}s timeout (GIZMOSQL_QUERY_TIMEOUT_SECONDS) and was cancelled.`,
    );
    this.name = "QueryTimeoutError";
  }
}

/** Grace added to the server-side timeout before the client-side abort fires. */
const CLIENT_DEADLINE_GRACE_MS = 5000;
/** If an abort does not settle the call (e.g. a DoPut update), drop the connection after this. */
const HARD_RESET_GRACE_MS = 15000;

/** A capped result: up to `maxRows + 1` rows so callers can detect truncation. */
export interface CappedResult {
  table: Table;
  /** True when more rows existed beyond `maxRows` (the extra row is not in `table`). */
  truncated: boolean;
}

const CONNECTION_LOST = /unavailable|connection (?:refused|reset|closed|lost)|transport is closing|broken pipe|\bEOF\b|not connected|failed to connect|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|canceled|deadline exceeded|no connection/i;

/** Heuristic: does this error indicate the underlying connection is unusable? */
export function isConnectionError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "ConnectionError" || name === "AuthenticationError") return name === "ConnectionError";
  const message = err instanceof Error ? err.message : String(err);
  return CONNECTION_LOST.test(message);
}

export interface SessionOverrides {
  /** Replaces the configured credentials (used by the SSO flow; kept in memory only). */
  username?: string;
  password?: string;
}

/** Session search path applied with `USE` on every (re)connect. */
export interface SearchPath {
  catalog?: string;
  schema?: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Builds the DuckDB `USE` statement for a search path, or null when empty. */
export function useStatement(path: SearchPath): string | null {
  const parts: string[] = [];
  if (path.catalog) parts.push(quoteIdent(path.catalog));
  if (path.schema) parts.push(quoteIdent(path.schema));
  return parts.length ? `USE ${parts.join(".")}` : null;
}

export interface RunOptions {
  /** Overrides the configured timeout for this operation (seconds; 0 = none). */
  timeoutSeconds?: number;
}

/**
 * One FlightSQLClient per process, opened lazily, serialized so a single
 * statement is in flight at a time, reconnected once on connection loss.
 * Timeouts are enforced server-side (`SET gizmosql.query_timeout`) with a
 * client-side deadline as backstop that cancels the statement through the
 * client's AbortSignal support; only if that fails to settle the call is
 * the connection dropped and reopened.
 */
export class GizmoConnection {
  private client: FlightSQLClient | null = null;
  private connecting: Promise<FlightSQLClient> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private overrides: SessionOverrides = {};
  private warnings: string[] = [];
  private searchPath: SearchPath;
  /** Wall-clock at which the current client was opened (for server_info). */
  connectedAt: Date | null = null;

  constructor(
    readonly config: ConnectionConfig,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {
    this.searchPath = { catalog: config.defaultCatalog, schema: config.defaultSchema };
  }

  /** The search path (`USE`) applied to every session. */
  currentSearchPath(): SearchPath {
    return { ...this.searchPath };
  }

  /**
   * Switches the session's default catalog/schema (`USE`) and remembers it
   * so reconnects apply it again. Throws when the server rejects it.
   */
  async useSchema(path: SearchPath): Promise<void> {
    const stmt = useStatement(path);
    if (!stmt) throw new Error("use_schema needs a catalog and/or schema name.");
    await this.run((c) => c.executeUpdate(stmt));
    this.searchPath = { ...path };
  }

  /** Secrets to redact from any message that might reach a client. */
  secrets(): Array<string | undefined> {
    return [this.config.password, this.overrides.password];
  }

  redact(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  /** Effective auth method, taking SSO overrides into account. */
  effectiveAuth(): { method: AuthMethod; user?: string } {
    if (this.overrides.username !== undefined) {
      return { method: "password", user: this.overrides.username };
    }
    const method = authMethod(this.config);
    return { method, user: method === "password" ? this.config.username : undefined };
  }

  /** Session-setup warnings (e.g. server too old for SET gizmosql.query_timeout). */
  sessionWarnings(): string[] {
    return [...this.warnings];
  }

  /** Swaps in new credentials (SSO) and drops the current connection. */
  async useCredentials(overrides: SessionOverrides): Promise<void> {
    this.overrides = overrides;
    await this.reset();
  }

  private clientConfig() {
    const base = {
      host: this.config.host,
      port: this.config.port,
      plaintext: this.config.plaintext,
      tlsSkipVerify: this.config.tlsSkipVerify,
      oauthPort: this.config.oauthPort,
    };
    if (this.overrides.username !== undefined) {
      return { ...base, username: this.overrides.username, password: this.overrides.password ?? "" };
    }
    if (this.config.username !== undefined) {
      return { ...base, username: this.config.username, password: this.config.password ?? "" };
    }
    return base;
  }

  /** Opens a fresh client and applies session settings. */
  private async open(): Promise<FlightSQLClient> {
    const client = new FlightSQLClient(this.clientConfig());
    await client.connect();
    this.warnings = [];
    if (this.config.queryTimeoutSeconds > 0) {
      try {
        await client.executeUpdate(
          `SET gizmosql.query_timeout = ${this.config.queryTimeoutSeconds}`,
        );
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err));
        this.warnings.push(
          `Server-side query timeout could not be set (server may predate SET gizmosql.query_timeout); ` +
            `falling back to the client-side deadline only. ${msg}`,
        );
        this.log(`[gizmosql-mcp] warning: ${this.warnings[this.warnings.length - 1]}`);
      }
    }
    const use = useStatement(this.searchPath);
    if (use) {
      try {
        await client.executeUpdate(use);
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err));
        let available = "";
        try {
          available = ` Available catalogs: ${(await client.getCatalogs()).join(", ")}.`;
        } catch {
          // best effort
        }
        this.warnings.push(
          `Default catalog/schema could not be applied (${use}); the server's own default is in effect.${available} ${msg}`,
        );
        this.log(`[gizmosql-mcp] warning: ${this.warnings[this.warnings.length - 1]}`);
      }
    }
    this.connectedAt = new Date();
    return client;
  }

  /** Returns the shared client, opening it on first use. */
  async get(): Promise<FlightSQLClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.open()
        .then((c) => {
          this.client = c;
          return c;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  /** Closes the current client (cancelling any in-flight statement server-side). */
  async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectedAt = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // already gone
      }
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  /**
   * Runs `fn` against the shared client with: serialization, one retry
   * after a connection-level failure, and a client-side deadline that
   * aborts the statement via `signal` (falling back to dropping the
   * connection if the abort does not settle the call).
   */
  async run<T>(
    fn: (client: FlightSQLClient, signal: AbortSignal | undefined) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const task = async (): Promise<T> => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const client = await this.get();
        try {
          return await this.withDeadline((signal) => fn(client, signal), options.timeoutSeconds);
        } catch (err) {
          if (err instanceof QueryTimeoutError) {
            throw err;
          }
          if (attempt < 2 && isConnectionError(err)) {
            this.log(
              `[gizmosql-mcp] connection error, reconnecting: ${this.redact(err instanceof Error ? err.message : String(err))}`,
            );
            await this.reset();
            continue;
          }
          throw err;
        }
      }
    };
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async withDeadline<T>(
    fn: (signal: AbortSignal | undefined) => Promise<T>,
    timeoutSeconds?: number,
  ): Promise<T> {
    const seconds = timeoutSeconds ?? this.config.queryTimeoutSeconds;
    if (!seconds || seconds <= 0) return fn(undefined);
    // The server enforces `gizmosql.query_timeout` at `seconds`; the
    // client-side abort is a backstop a few seconds later.
    const controller = new AbortController();
    const timeoutError = new QueryTimeoutError(seconds);
    let abortTimer: NodeJS.Timeout | undefined;
    let resetTimer: NodeJS.Timeout | undefined;
    const hardReset = new Promise<never>((_, reject) => {
      abortTimer = setTimeout(() => {
        controller.abort(timeoutError);
        // If the abort cannot interrupt the call (e.g. a DoPut update),
        // drop the connection so the server sees the client go away.
        resetTimer = setTimeout(() => {
          void this.reset().finally(() => reject(timeoutError));
        }, HARD_RESET_GRACE_MS);
      }, seconds * 1000 + CLIENT_DEADLINE_GRACE_MS);
    });
    try {
      return await Promise.race([fn(controller.signal), hardReset]);
    } catch (err) {
      if (controller.signal.aborted && (err instanceof QueryCancelledError || err === timeoutError)) {
        throw timeoutError;
      }
      throw err;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (resetTimer) clearTimeout(resetTimer);
    }
  }

  /** Convenience: execute a query returning an Arrow table. */
  query(sql: string, params?: SqlParameters, options?: RunOptions): Promise<Table> {
    return this.run((c, signal) => c.execute(sql, params, { signal }), options);
  }

  /**
   * Executes a query and reads at most `maxRows + 1` rows from the result
   * stream, then releases the stream so no further batches are transferred.
   */
  queryCapped(
    sql: string,
    params: SqlParameters | undefined,
    maxRows: number,
    options?: RunOptions,
  ): Promise<CappedResult> {
    return this.run(async (c, signal) => {
      const stream = await c.executeStream(sql, params, { signal });
      const batches: RecordBatch[] = [];
      let rows = 0;
      for await (const batch of stream) {
        batches.push(batch);
        rows += batch.numRows;
        if (rows > maxRows) break; // releases the stream
      }
      const table = new Table(stream.schema, batches);
      return { table: rows > maxRows ? table.slice(0, maxRows) : table, truncated: rows > maxRows };
    }, options);
  }

  /** Convenience: execute a statement returning the affected-row count. */
  update(sql: string, params?: SqlParameters, options?: RunOptions): Promise<number> {
    return this.run((c, signal) => c.executeUpdate(sql, params, { signal }), options);
  }
}
