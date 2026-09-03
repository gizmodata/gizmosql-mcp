import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Bool,
  DateDay,
  Decimal,
  Float64,
  Int32,
  Int64,
  Table,
  TimestampMillisecond,
  Utf8,
  vectorFromArray,
} from "apache-arrow";

import {
  cellToJson,
  escapeMarkdownCell,
  formatDecimal,
  formatTable,
  resultFooter,
  toMarkdownTable,
  truncateText,
} from "../../dist/format.js";

describe("truncateText", () => {
  it("counts Unicode code points, not UTF-16 units", () => {
    assert.equal(truncateText("abc", 5), "abc");
    assert.equal(truncateText("abcdef", 3), "abc…");
    // Emoji and CJK are single code points each.
    assert.equal(truncateText("🙂🙂🙂🙂", 2), "🙂🙂…");
    assert.equal(truncateText("漢字漢字", 3), "漢字漢…");
    assert.equal(truncateText("é漢🙂x", 4), "é漢🙂x");
  });

  it("handles zero limits", () => {
    assert.equal(truncateText("", 0), "");
    assert.equal(truncateText("x", 0), "…");
  });
});

describe("escapeMarkdownCell", () => {
  it("escapes pipes, backslashes and newlines", () => {
    assert.equal(escapeMarkdownCell("a|b\\c\nd\r\ne"), "a\\|b\\\\c\\nd\\ne");
  });
});

describe("toMarkdownTable", () => {
  it("renders a header, separator and rows", () => {
    assert.equal(
      toMarkdownTable(["a", "b|c"], [["1", "2"]]),
      "| a | b\\|c |\n| --- | --- |\n| 1 | 2 |",
    );
  });
});

describe("formatDecimal", () => {
  it("inserts the decimal point according to scale", () => {
    assert.equal(formatDecimal("150", 2), "1.50");
    assert.equal(formatDecimal("5", 2), "0.05");
    assert.equal(formatDecimal("-5", 2), "-0.05");
    assert.equal(formatDecimal("12345", 0), "12345");
    assert.equal(formatDecimal("-12345", 3), "-12.345");
  });
});

describe("cellToJson", () => {
  it("renders nulls, bigints, dates and timestamps", () => {
    assert.equal(cellToJson(null, new Utf8()), null);
    assert.equal(cellToJson(undefined, new Int32()), null);
    assert.equal(cellToJson(42n, new Int64()), 42);
    assert.equal(cellToJson(9223372036854775807n, new Int64()), "9223372036854775807");
    assert.equal(cellToJson(Date.UTC(2024, 0, 2), new DateDay()), "2024-01-02");
    assert.equal(
      cellToJson(Date.UTC(2024, 0, 2, 3, 4, 5, 6), new TimestampMillisecond()),
      "2024-01-02T03:04:05.006",
    );
    assert.equal(
      cellToJson(Date.UTC(2024, 0, 2, 3, 4, 5), new TimestampMillisecond("UTC")),
      "2024-01-02T03:04:05Z",
    );
  });

  it("scales decimals", () => {
    assert.equal(cellToJson(150n, new Decimal(2, 10, 128)), "1.50");
  });
});

describe("formatTable", () => {
  const table = new Table({
    id: vectorFromArray([1, 2, 3], new Int32()),
    name: vectorFromArray(["alpha", null, "a|b"], new Utf8()),
    ok: vectorFromArray([true, false, null], new Bool()),
    score: vectorFromArray([1.5, null, -2.25], new Float64()),
  });

  it("caps rows, truncates cells, renders NULL and escapes pipes", () => {
    const out = formatTable(table, { maxRows: 2, maxCellChars: 3 });
    assert.equal(out.rowCount, 2);
    assert.equal(out.truncated, true);
    assert.deepEqual(
      out.columns.map((c) => c.name),
      ["id", "name", "ok", "score"],
    );
    assert.deepEqual(out.rows, [
      [1, "alpha", true, 1.5],
      [2, null, false, null],
    ]);
    assert.equal(
      out.markdown,
      "| id | name | ok | score |\n| --- | --- | --- | --- |\n| 1 | alp… | tru… | 1.5 |\n| 2 | NUL… | fal… | NUL… |",
    );
  });

  it("does not report truncation when everything fits", () => {
    const out = formatTable(table, { maxRows: 10, maxCellChars: 100 });
    assert.equal(out.rowCount, 3);
    assert.equal(out.truncated, false);
    assert.equal(out.rows[2][1], "a|b");
    assert.match(out.markdown, /a\\\|b/);
  });

  it("handles empty tables", () => {
    const empty = new Table({ id: vectorFromArray([], new Int32()) });
    const out = formatTable(empty, { maxRows: 5, maxCellChars: 5 });
    assert.equal(out.rowCount, 0);
    assert.equal(out.truncated, false);
    assert.equal(out.markdown, "| id |\n| --- |");
  });
});

describe("resultFooter", () => {
  it("describes counts, truncation and elapsed time", () => {
    assert.equal(
      resultFooter({ rowCount: 1, truncated: false, maxRows: 5, elapsedMs: 12 }),
      "1 row returned · 12 ms",
    );
    assert.equal(
      resultFooter({ rowCount: 5, truncated: true, maxRows: 5, elapsedMs: 3 }),
      "5 rows returned (truncated: more rows exist beyond max_rows=5) · 3 ms",
    );
  });
});
