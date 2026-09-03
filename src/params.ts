// Conversion of JSON tool arguments into the typed values that
// @gizmodata/gizmosql-client binds to `?` / `$1` placeholders.
//
// Plain JSON values map as: string -> Utf8 (unless it is an ISO-8601
// date/timestamp, which becomes a Date -> Timestamp), number -> Int32/
// Int64/Float64, boolean -> Bool, null -> Null. A typed object form
// `{ "type": "...", "value": ... }` disambiguates the cases JSON cannot
// express (bigint, binary, a string that merely looks like a date).

import type { SqlParameterValue } from "@gizmodata/gizmosql-client";
import { z } from "zod";

export const TYPED_PARAM_TYPES = [
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "timestamp",
  "binary",
  "null",
] as const;

export type TypedParamType = (typeof TYPED_PARAM_TYPES)[number];

export const typedParamSchema = z
  .object({
    type: z.enum(TYPED_PARAM_TYPES),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

export const paramValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  typedParamSchema,
]);

export const paramsSchema = z.array(paramValueSchema);

export type JsonParamValue = z.infer<typeof paramValueSchema>;

export class ParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParameterError";
  }
}

// YYYY-MM-DD
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
// YYYY-MM-DD[T ]HH:MM[:SS[.fraction]][Z|±HH[:MM]]
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u;

/** Parses an ISO-8601 date or timestamp string into a Date (UTC when no zone given). */
export function parseIsoDateTime(text: string): Date | undefined {
  if (ISO_DATE.test(text)) {
    const d = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (ISO_TIMESTAMP.test(text)) {
    let normalized = text.replace(" ", "T");
    // Treat zone-less timestamps as UTC so the bound value is deterministic.
    if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(normalized)) normalized += "Z";
    // Trim fractions beyond milliseconds (Date only keeps ms).
    normalized = normalized.replace(/(\.\d{3})\d+/u, "$1");
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function convertTyped(index: number, type: TypedParamType, value: unknown): SqlParameterValue {
  const where = `parameter ${index + 1} (type "${type}")`;
  switch (type) {
    case "null":
      return null;
    case "string":
      if (value === null || value === undefined) return null;
      return String(value);
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new ParameterError(`${where}: expected a boolean value.`);
    case "number":
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
      throw new ParameterError(`${where}: expected a numeric value.`);
    case "bigint": {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
          throw new ParameterError(
            `${where}: ${value} is not a safe integer; pass the value as a decimal string.`,
          );
        }
        return BigInt(value);
      }
      if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
        return BigInt(value.trim());
      }
      throw new ParameterError(`${where}: expected an integer or a decimal-digit string.`);
    }
    case "date":
    case "timestamp": {
      if (typeof value === "number") return new Date(value);
      if (typeof value === "string") {
        const d = parseIsoDateTime(value) ?? new Date(value);
        if (Number.isNaN(d.getTime())) {
          throw new ParameterError(`${where}: "${value}" is not a valid ISO-8601 date/timestamp.`);
        }
        return d;
      }
      throw new ParameterError(`${where}: expected an ISO-8601 string or epoch milliseconds.`);
    }
    case "binary": {
      if (typeof value !== "string") {
        throw new ParameterError(`${where}: expected a base64 string.`);
      }
      return new Uint8Array(Buffer.from(value, "base64"));
    }
    default:
      throw new ParameterError(`${where}: unsupported parameter type.`);
  }
}

/** Converts one JSON parameter value into a bindable client value. */
export function convertParam(index: number, value: JsonParamValue): SqlParameterValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new ParameterError(
        `parameter ${index + 1}: ${value} exceeds JavaScript's safe integer range; ` +
          `pass it as {"type":"bigint","value":"<digits>"}.`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    return parseIsoDateTime(value) ?? value;
  }
  if (typeof value === "object" && value !== null && "type" in value) {
    return convertTyped(index, value.type, value.value);
  }
  throw new ParameterError(`parameter ${index + 1}: unsupported value.`);
}

/**
 * Converts the JSON `params` array from a tool call into the positional
 * values bound by the client. Returns `undefined` when there is nothing
 * to bind.
 */
export function convertParams(params: JsonParamValue[] | undefined): SqlParameterValue[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params.map((v, i) => convertParam(i, v));
}

/** Documentation for the `params` argument, shared by run_query / execute_statement. */
export const PARAMS_DESCRIPTION =
  "Optional JSON array of values bound positionally to ? or $1, $2, ... placeholders in the SQL " +
  "(typed Arrow parameters — never string interpolation). Use placeholders for any literal that " +
  "comes from user input or data. Accepted values: string, number, boolean, null, and ISO-8601 " +
  "date/timestamp strings (converted to TIMESTAMP). For explicit types use " +
  '{"type":"bigint"|"date"|"timestamp"|"binary"|"string"|"number"|"boolean"|"null","value":...} ' +
  '(binary values are base64). Note: a placeholder whose type the server cannot infer from ' +
  "context (e.g. SELECT ?) must be cast, e.g. SELECT ?::INTEGER.";
