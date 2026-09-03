// Read-only classification and result-limit wrapping for SQL text.
//
// This is defense in depth, not the security boundary: the GizmoSQL
// user's database-level role/privileges are the real boundary (see the
// README). The classifier is deliberately conservative — anything it
// cannot confidently classify as a read is rejected when writes are
// disabled.

export type StatementKind = "read" | "write" | "unknown";

export interface Classification {
  /** Whether the statement is a read, a write, or could not be classified. */
  kind: StatementKind;
  /** The leading keyword that determined the classification (upper-cased). */
  keyword: string;
  /**
   * Whether the statement can be wrapped as `SELECT * FROM (<sql>) LIMIT n`
   * to enforce the row cap on the server side.
   */
  wrappable: boolean;
}

/** Leading keywords that are always reads and can be wrapped in a subquery. */
const WRAPPABLE_READ_KEYWORDS = new Set([
  "SELECT",
  "FROM", // DuckDB FROM-first syntax
  "VALUES",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "SUMMARIZE",
  "TABLE", // `TABLE t` is shorthand for SELECT * FROM t
]);

/** Leading keywords that are reads but cannot be used as a subquery. */
const UNWRAPPABLE_READ_KEYWORDS = new Set(["EXPLAIN", "PRAGMA"]);

/** Everything here is a write / side-effecting statement. */
const WRITE_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "REPLACE",
  "TRUNCATE",
  "CREATE",
  "DROP",
  "ALTER",
  "RENAME",
  "COPY",
  "EXPORT",
  "IMPORT",
  "ATTACH",
  "DETACH",
  "INSTALL",
  "FORCE", // FORCE INSTALL / FORCE CHECKPOINT
  "LOAD",
  "SET",
  "RESET",
  "USE",
  "CALL",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "ABORT",
  "END",
  "CHECKPOINT",
  "VACUUM",
  "ANALYZE",
  "GRANT",
  "REVOKE",
  "KILL",
  "COMMENT",
  "PIVOT",
  "UNPIVOT",
]);

// PIVOT/UNPIVOT are reads in DuckDB, but they are rewritten by the
// binder into multiple internal statements and cannot be prepared with
// parameters or reliably wrapped; treat them as unclassifiable rather
// than as writes.
WRITE_KEYWORDS.delete("PIVOT");
WRITE_KEYWORDS.delete("UNPIVOT");

/** Tokens produced by the lightweight lexer. */
interface Token {
  /** Upper-cased text for keywords/identifiers; raw text for punctuation. */
  text: string;
  /** Token category. */
  kind: "word" | "punct" | "string" | "quoted";
  /** Offset of the token start in the comment-stripped SQL. */
  start: number;
}

/**
 * Removes SQL comments (`-- ...`, `/* ... *\/` with nesting) while
 * preserving string literals, quoted identifiers and dollar-quoted
 * strings. Comments are replaced by a single space so offsets stay
 * meaningful for error messages.
 */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" ) {
      // single-quoted string with '' escapes
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      // dollar-quoted string: $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        const stop = end === -1 ? n : end + delim.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      out += " ";
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += " ";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Tokenizes comment-stripped SQL into words, punctuation and literals. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push({ text: sql.slice(i, j + 1), kind: "string", start: i });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push({ text: sql.slice(i, j + 1), kind: "quoted", start: i });
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        const stop = end === -1 ? n : end + delim.length;
        tokens.push({ text: sql.slice(i, stop), kind: "string", start: i });
        i = stop;
        continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (word) {
      tokens.push({ text: word[0].toUpperCase(), kind: "word", start: i });
      i += word[0].length;
      continue;
    }
    tokens.push({ text: ch, kind: "punct", start: i });
    i++;
  }
  return tokens;
}

/**
 * Splits SQL into top-level statements on semicolons that are outside
 * strings, quoted identifiers and comments. Empty statements (e.g. from a
 * trailing semicolon) are dropped.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripComments(sql);
  const tokens = tokenize(stripped);
  const statements: string[] = [];
  let start = 0;
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") {
      const piece = stripped.slice(start, t.start).trim();
      if (piece) statements.push(piece);
      start = t.start + 1;
    }
  }
  const tail = stripped.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Returns the statement with comments removed and any trailing
 * semicolons stripped, ready to be wrapped in a subquery.
 */
export function normalizeStatement(sql: string): string {
  return stripComments(sql).trim().replace(/;+\s*$/u, "").trim();
}

/** Index of the token that closes the parenthesis opened at `open`. */
function matchParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "punct") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Given tokens starting at a `WITH`, returns the index of the first token
 * of the main statement that follows the CTE list, or -1 if the CTE list
 * cannot be parsed.
 */
function skipCteList(tokens: Token[], withIndex: number): number {
  let i = withIndex + 1;
  if (tokens[i]?.text === "RECURSIVE") i++;
  for (;;) {
    // cte name
    const name = tokens[i];
    if (!name || (name.kind !== "word" && name.kind !== "quoted")) return -1;
    i++;
    // optional column list
    if (tokens[i]?.kind === "punct" && tokens[i].text === "(") {
      const close = matchParen(tokens, i);
      if (close === -1) return -1;
      i = close + 1;
    }
    if (tokens[i]?.text !== "AS") return -1;
    i++;
    if (tokens[i]?.text === "NOT") i++;
    if (tokens[i]?.text === "MATERIALIZED") i++;
    if (!(tokens[i]?.kind === "punct" && tokens[i].text === "(")) return -1;
    const close = matchParen(tokens, i);
    if (close === -1) return -1;
    i = close + 1;
    if (tokens[i]?.kind === "punct" && tokens[i].text === ",") {
      i++;
      continue;
    }
    return i < tokens.length ? i : -1;
  }
}

/**
 * Classifies a single SQL statement by its leading keyword, looking
 * through leading parentheses and CTE lists to find the statement that
 * actually executes.
 */
export function classifyStatement(sql: string): Classification {
  const tokens = tokenize(stripComments(sql));
  let i = 0;
  let sawWith = false;
  for (let guard = 0; guard < 64 && i < tokens.length; guard++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.text === "(") {
      // `(SELECT ...) UNION (SELECT ...)` — classify the inner statement.
      i++;
      continue;
    }
    if (t.kind !== "word") {
      return { kind: "unknown", keyword: t.text, wrappable: false };
    }
    if (t.text === "WITH") {
      sawWith = true;
      const main = skipCteList(tokens, i);
      if (main === -1) {
        return { kind: "unknown", keyword: "WITH", wrappable: false };
      }
      i = main;
      continue;
    }
    if (WRAPPABLE_READ_KEYWORDS.has(t.text)) {
      return { kind: "read", keyword: sawWith ? "WITH" : t.text, wrappable: true };
    }
    if (UNWRAPPABLE_READ_KEYWORDS.has(t.text)) {
      if (t.text === "PRAGMA") {
        // `PRAGMA name` / `PRAGMA fn(args)` are reads; `PRAGMA x = y` mutates settings.
        const hasAssignment = tokens
          .slice(i + 1)
          .some((tok) => tok.kind === "punct" && tok.text === "=");
        if (hasAssignment) {
          return { kind: "write", keyword: "PRAGMA", wrappable: false };
        }
      }
      if (t.text === "EXPLAIN") {
        // EXPLAIN of a write is a read (it never executes), but keep it
        // conservative: classify the explained statement instead.
        let j = i + 1;
        if (tokens[j]?.text === "ANALYZE") j++;
        if (tokens[j]?.kind === "punct" && tokens[j].text === "(") {
          // EXPLAIN (FORMAT ...) options
          const close = matchParen(tokens, j);
          if (close !== -1) j = close + 1;
        }
        const inner = classifyStatement(
          stripComments(sql).slice(tokens[j]?.start ?? sql.length),
        );
        return { kind: inner.kind, keyword: "EXPLAIN", wrappable: false };
      }
      return { kind: "read", keyword: t.text, wrappable: false };
    }
    if (WRITE_KEYWORDS.has(t.text)) {
      return { kind: "write", keyword: t.text, wrappable: false };
    }
    return { kind: "unknown", keyword: t.text, wrappable: false };
  }
  return { kind: "unknown", keyword: "", wrappable: false };
}

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

export interface GuardedStatement {
  /** Comment-stripped statement without trailing semicolons. */
  sql: string;
  classification: Classification;
}

/**
 * Validates that `sql` is exactly one statement and, when writes are
 * disabled, that it is a read. Throws {@link SqlGuardError} otherwise.
 */
export function guardStatement(sql: string, allowWrites: boolean): GuardedStatement {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new SqlGuardError("SQL statement is empty.");
  }
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new SqlGuardError("SQL statement is empty (only comments/semicolons).");
  }
  if (statements.length > 1) {
    throw new SqlGuardError(
      `Only one SQL statement per call is allowed (found ${statements.length}). ` +
        "Split the statements into separate calls.",
    );
  }
  const single = normalizeStatement(statements[0]);
  const classification = classifyStatement(single);
  if (!allowWrites) {
    if (classification.kind === "write") {
      throw new SqlGuardError(
        `Statement type ${classification.keyword} is not allowed: this server is read-only ` +
          "(GIZMOSQL_ALLOW_WRITES is not enabled). Only SELECT/WITH/FROM/VALUES/SHOW/" +
          "DESCRIBE/SUMMARIZE/EXPLAIN/PRAGMA (read) statements are permitted.",
      );
    }
    if (classification.kind === "unknown") {
      throw new SqlGuardError(
        `Unable to classify statement starting with "${classification.keyword || single.slice(0, 20)}" ` +
          "as read-only; this server is read-only (GIZMOSQL_ALLOW_WRITES is not enabled). " +
          "Rewrite it as a SELECT/WITH query.",
      );
    }
  }
  return { sql: single, classification };
}

/** Alias used by the query wrapper so it never collides with user aliases. */
export const WRAPPER_ALIAS = "gizmosql_mcp_q";

/**
 * Wraps a read statement so the server enforces the row cap:
 * `SELECT * FROM (<sql>) AS gizmosql_mcp_q LIMIT <limit>`.
 * The caller must pass a normalized (comment-free, no trailing `;`) statement.
 */
export function wrapWithLimit(sql: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SqlGuardError(`Row limit must be a positive integer (got ${limit}).`);
  }
  return `SELECT * FROM (\n${sql}\n) AS ${WRAPPER_ALIAS} LIMIT ${limit}`;
}
