// Arrow -> Markdown / JSON rendering with cell truncation and row caps.

import {
  DataType,
  type Field,
  type Table,
} from "apache-arrow";

export interface FormatOptions {
  /** Maximum number of rows to render. */
  maxRows: number;
  /** Maximum characters per cell before truncation with `…`. */
  maxCellChars: number;
}

export interface ColumnInfo {
  name: string;
  /** Arrow type rendered as a string, e.g. `Int64`, `Utf8`, `Decimal[10e+2]`. */
  type: string;
}

export interface FormattedResult {
  columns: ColumnInfo[];
  /** JSON-safe row values (bigint -> number/string, dates -> ISO, binary -> base64). */
  rows: unknown[][];
  /** Rows actually rendered (<= maxRows). */
  rowCount: number;
  /** True when the source table held more rows than `rowCount`. */
  truncated: boolean;
  /** Markdown table of the rendered rows. */
  markdown: string;
}

const ELLIPSIS = "…";

/**
 * Truncates `text` to `maxChars` Unicode code points (never splitting a
 * surrogate pair), appending `…` when anything was removed.
 */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return text.length === 0 ? "" : ELLIPSIS;
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  return points.slice(0, maxChars).join("") + ELLIPSIS;
}

/** Escapes a cell for use inside a Markdown table row. */
export function escapeMarkdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}

/** Renders a Markdown table. Cells must already be escaped/truncated strings. */
export function toMarkdownTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

const BIGINT_SAFE = (v: bigint): number | string =>
  v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoTimestamp(ms: number, withZone: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const millis = d.getUTCMilliseconds();
  const frac = millis ? `.${pad(millis, 3)}` : "";
  return `${base}${frac}${withZone ? "Z" : ""}`;
}

/** Renders a Time value given the Arrow time unit (0=s,1=ms,2=us,3=ns). */
function isoTime(value: number | bigint, unit: number): string {
  const perSecond = [1n, 1000n, 1000000n, 1000000000n][unit] ?? 1n;
  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  const totalSeconds = v / perSecond;
  const fraction = v % perSecond;
  const h = totalSeconds / 3600n;
  const m = (totalSeconds % 3600n) / 60n;
  const s = totalSeconds % 60n;
  let out = `${pad(Number(h))}:${pad(Number(m))}:${pad(Number(s))}`;
  if (fraction !== 0n) {
    const digits = [0, 3, 6, 9][unit] ?? 0;
    out += `.${fraction.toString().padStart(digits, "0").replace(/0+$/, "")}`;
  }
  return out;
}

/** Formats an unscaled decimal (as a decimal-digit string) with `scale` digits. */
export function formatDecimal(unscaled: string, scale: number): string {
  let digits = unscaled;
  let sign = "";
  if (digits.startsWith("-")) {
    sign = "-";
    digits = digits.slice(1);
  }
  if (scale <= 0) return sign + digits;
  digits = digits.padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return `${sign}${intPart}.${fracPart}`;
}

/** Converts an Arrow decimal cell value (BigNum / bigint / number) to its unscaled digit string. */
function decimalUnscaled(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return BigInt(Math.trunc(value)).toString();
  const asObj = value as { toString?: () => string; valueOf?: () => unknown };
  // apache-arrow BN objects stringify to their (signed) integer value.
  if (asObj && typeof asObj.toString === "function") {
    const s = asObj.toString();
    if (/^-?\d+$/.test(s)) return s;
  }
  return String(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function jsonReplacer(_key: string, v: unknown): unknown {
  if (typeof v === "bigint") return BIGINT_SAFE(v);
  if (v instanceof Uint8Array) return bytesToBase64(v);
  return v;
}

/** Recursively converts nested Arrow values (Vector / StructRow / MapRow) to plain JSON. */
function nestedToJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return BIGINT_SAFE(value);
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  const obj = value as { toJSON?: () => unknown; toArray?: () => unknown[] };
  if (typeof obj.toJSON === "function") {
    return nestedToJson(obj.toJSON());
  }
  if (Array.isArray(value)) return value.map(nestedToJson);
  if (typeof obj.toArray === "function") {
    return Array.from(obj.toArray(), nestedToJson);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = nestedToJson(v);
  }
  return out;
}

/**
 * Converts one Arrow cell to a JSON-safe value using the column type for
 * temporal / decimal / binary rendering.
 */
export function cellToJson(value: unknown, type: DataType): unknown {
  if (value === null || value === undefined) return null;
  if (DataType.isDecimal(type)) {
    return formatDecimal(decimalUnscaled(value), type.scale);
  }
  if (DataType.isDate(type)) {
    const ms = typeof value === "bigint" ? Number(value) : (value as number);
    return isoDate(ms);
  }
  if (DataType.isTimestamp(type)) {
    const ms = typeof value === "bigint" ? Number(value) : (value as number);
    return isoTimestamp(ms, Boolean(type.timezone));
  }
  if (DataType.isTime(type)) {
    return isoTime(value as number | bigint, type.unit as number);
  }
  if (DataType.isInterval(type) || DataType.isDuration(type)) {
    return intervalToString(value);
  }
  if (DataType.isBinary(type) || DataType.isLargeBinary(type) || DataType.isFixedSizeBinary(type)) {
    return bytesToBase64(value as Uint8Array);
  }
  if (typeof value === "bigint") return BIGINT_SAFE(value);
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return nestedToJson(value);
}

function intervalToString(value: unknown): string {
  // MONTH_DAY_NANO intervals arrive as Int32Array [months, days, nanosLo, nanosHi];
  // DAY_TIME as [days, millis]; YEAR_MONTH as a number of months.
  if (value instanceof Int32Array || Array.isArray(value)) {
    const arr = Array.from(value as ArrayLike<number>);
    if (arr.length === 4) {
      const nanos = BigInt.asUintN(32, BigInt(arr[2])) + (BigInt(arr[3]) << 32n);
      const seconds = Number(nanos) / 1e9;
      return `${arr[0]} months ${arr[1]} days ${seconds} seconds`;
    }
    if (arr.length === 2) {
      return `${arr[0]} days ${arr[1] / 1000} seconds`;
    }
  }
  if (typeof value === "number") return `${value} months`;
  if (typeof value === "bigint") return value.toString();
  return nestedToJson(value) === null ? "NULL" : JSON.stringify(nestedToJson(value), jsonReplacer);
}

/** Renders a JSON-safe cell value as display text (no truncation). */
export function cellToText(json: unknown): string {
  if (json === null || json === undefined) return "NULL";
  if (typeof json === "string") return json;
  if (typeof json === "number" || typeof json === "boolean" || typeof json === "bigint") {
    return String(json);
  }
  return JSON.stringify(json, jsonReplacer);
}

/** Human-readable Arrow type name for a field. */
export function fieldTypeName(field: Field): string {
  return String(field.type);
}

/**
 * Renders up to `maxRows` rows of an Arrow table as Markdown and JSON.
 * Reads column vectors row-by-row and stops at the cap — it never
 * materializes the whole table into JS objects.
 */
export function formatTable(table: Table, options: FormatOptions): FormattedResult {
  const fields = table.schema.fields;
  const columns: ColumnInfo[] = fields.map((f) => ({ name: f.name, type: fieldTypeName(f) }));
  const total = table.numRows;
  const limit = Math.max(0, Math.min(options.maxRows, total));
  const vectors = fields.map((_, i) => table.getChildAt(i));

  const rows: unknown[][] = [];
  const textRows: string[][] = [];
  for (let r = 0; r < limit; r++) {
    const jsonRow: unknown[] = [];
    const textRow: string[] = [];
    for (let c = 0; c < fields.length; c++) {
      const raw = vectors[c]?.get(r);
      const json = cellToJson(raw, fields[c].type);
      jsonRow.push(json);
      textRow.push(escapeMarkdownCell(truncateText(cellToText(json), options.maxCellChars)));
    }
    rows.push(jsonRow);
    textRows.push(textRow);
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: total > limit,
    markdown: toMarkdownTable(
      columns.map((c) => c.name),
      textRows,
    ),
  };
}

/** Footer line appended to query results. */
export function resultFooter(input: {
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  elapsedMs: number;
}): string {
  const rows = `${input.rowCount} row${input.rowCount === 1 ? "" : "s"} returned`;
  const trunc = input.truncated
    ? ` (truncated: more rows exist beyond max_rows=${input.maxRows})`
    : "";
  return `${rows}${trunc} · ${input.elapsedMs} ms`;
}
