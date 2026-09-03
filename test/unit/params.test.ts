import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { convertParam, convertParams, ParameterError, paramsSchema, parseIsoDateTime } from "../../dist/params.js";

describe("parseIsoDateTime", () => {
  it("parses dates and timestamps as UTC", () => {
    assert.equal(parseIsoDateTime("2024-01-02")?.toISOString(), "2024-01-02T00:00:00.000Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04:05Z")?.toISOString(), "2024-01-02T03:04:05.000Z");
    assert.equal(parseIsoDateTime("2024-01-02 03:04:05.123")?.toISOString(), "2024-01-02T03:04:05.123Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04:05.123456789")?.toISOString(), "2024-01-02T03:04:05.123Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04+02:00")?.toISOString(), "2024-01-02T01:04:00.000Z");
  });

  it("rejects non-dates", () => {
    assert.equal(parseIsoDateTime("hello"), undefined);
    assert.equal(parseIsoDateTime("2024-13-45"), undefined);
    assert.equal(parseIsoDateTime("20240102"), undefined);
    assert.equal(parseIsoDateTime("12345"), undefined);
  });
});

describe("convertParam", () => {
  it("passes through primitives", () => {
    assert.equal(convertParam(0, "text"), "text");
    assert.equal(convertParam(0, 42), 42);
    assert.equal(convertParam(0, 1.5), 1.5);
    assert.equal(convertParam(0, true), true);
    assert.equal(convertParam(0, null), null);
  });

  it("converts ISO-8601 strings to Date", () => {
    const d = convertParam(0, "2024-01-02T03:04:05Z");
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), "2024-01-02T03:04:05.000Z");
    const day = convertParam(0, "2024-01-02");
    assert.ok(day instanceof Date);
  });

  it("supports the typed object form", () => {
    assert.equal(convertParam(0, { type: "string", value: "2024-01-02" }), "2024-01-02");
    assert.equal(convertParam(0, { type: "bigint", value: "9223372036854775807" }), 9223372036854775807n);
    assert.equal(convertParam(0, { type: "bigint", value: 7 }), 7n);
    assert.equal(convertParam(0, { type: "number", value: "1.25" }), 1.25);
    assert.equal(convertParam(0, { type: "boolean", value: "false" }), false);
    assert.equal(convertParam(0, { type: "null" }), null);
    const ts = convertParam(0, { type: "timestamp", value: 0 });
    assert.ok(ts instanceof Date && ts.getTime() === 0);
    const bin = convertParam(0, { type: "binary", value: Buffer.from([1, 2, 3]).toString("base64") });
    assert.ok(bin instanceof Uint8Array);
    assert.deepEqual(Array.from(bin), [1, 2, 3]);
  });

  it("rejects unsafe integers and bad typed values", () => {
    assert.throws(() => convertParam(0, 2 ** 53), ParameterError);
    assert.throws(() => convertParam(0, { type: "bigint", value: "abc" }), ParameterError);
    assert.throws(() => convertParam(0, { type: "bigint", value: 2 ** 53 }), ParameterError);
    assert.throws(() => convertParam(0, { type: "timestamp", value: "nope" }), ParameterError);
    assert.throws(() => convertParam(0, { type: "boolean", value: "maybe" }), ParameterError);
    assert.throws(() => convertParam(0, { type: "binary", value: 5 }), ParameterError);
  });
});

describe("convertParams", () => {
  it("returns undefined for nothing to bind", () => {
    assert.equal(convertParams(undefined), undefined);
    assert.equal(convertParams([]), undefined);
  });

  it("converts positionally", () => {
    const out = convertParams([1, "a", null, "2024-01-02"]);
    assert.equal(out?.length, 4);
    assert.ok(out?.[3] instanceof Date);
  });
});

describe("paramsSchema", () => {
  it("accepts primitives and typed objects, rejects nested arrays", () => {
    assert.ok(paramsSchema.safeParse([1, "a", true, null, { type: "bigint", value: "1" }]).success);
    assert.equal(paramsSchema.safeParse([[1]]).success, false);
    assert.equal(paramsSchema.safeParse([{ type: "nope", value: 1 }]).success, false);
    assert.equal(paramsSchema.safeParse([{ value: 1 }]).success, false);
  });
});
