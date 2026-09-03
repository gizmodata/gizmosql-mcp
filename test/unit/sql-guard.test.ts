import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyStatement,
  guardStatement,
  normalizeStatement,
  splitStatements,
  SqlGuardError,
  stripComments,
  wrapWithLimit,
} from "../../dist/sql-guard.js";

describe("stripComments", () => {
  it("removes line and block comments but keeps string contents", () => {
    const sql = "SELECT '-- not a comment', \"/* nor this */\" -- real\n/* block /* nested */ */ FROM t";
    const out = stripComments(sql);
    assert.equal(out, "SELECT '-- not a comment', \"/* nor this */\"  \n  FROM t");
  });

  it("keeps dollar-quoted strings intact", () => {
    const sql = "SELECT $$a; -- b$$ AS x";
    assert.equal(stripComments(sql), sql);
  });
});

describe("splitStatements", () => {
  it("splits on top-level semicolons only", () => {
    assert.deepEqual(splitStatements("SELECT 1; SELECT ';' ; "), ["SELECT 1", "SELECT ';'"]);
  });

  it("ignores trailing semicolons and comment-only input", () => {
    assert.deepEqual(splitStatements("SELECT 1;;"), ["SELECT 1"]);
    assert.deepEqual(splitStatements("-- nothing\n"), []);
  });
});

describe("classifyStatement", () => {
  const read = (sql: string, wrappable = true) => {
    const c = classifyStatement(sql);
    assert.equal(c.kind, "read", `${sql} should be a read (got ${c.kind}/${c.keyword})`);
    assert.equal(c.wrappable, wrappable, `${sql} wrappable`);
  };
  const write = (sql: string) => {
    const c = classifyStatement(sql);
    assert.equal(c.kind, "write", `${sql} should be a write (got ${c.kind}/${c.keyword})`);
  };

  it("accepts plain reads", () => {
    read("SELECT 1");
    read("  select * from t");
    read("FROM t SELECT a");
    read("VALUES (1), (2)");
    read("SHOW TABLES");
    read("SHOW ALL TABLES");
    read("DESCRIBE t");
    read("DESC t");
    read("SUMMARIZE t");
    read("TABLE t");
    read("(SELECT 1) UNION (SELECT 2)");
    read("/* leading */ SELECT 1");
  });

  it("accepts CTEs that end in a read", () => {
    read("WITH x AS (SELECT 1) SELECT * FROM x");
    read("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n < 5) SELECT * FROM x");
    read("WITH a AS (SELECT 1), b AS MATERIALIZED (SELECT 2), c AS NOT MATERIALIZED (SELECT 3) SELECT * FROM a, b, c");
    read("WITH x AS (SELECT 1) FROM x");
  });

  it("rejects CTEs that end in a write", () => {
    write("WITH x AS (SELECT 1) DELETE FROM t");
    write("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x");
    write("WITH x AS (SELECT 1) UPDATE t SET a = 1");
    write("WITH x AS (SELECT 1) CREATE TABLE y AS SELECT * FROM x");
  });

  it("classifies EXPLAIN and PRAGMA as unwrappable reads", () => {
    read("EXPLAIN SELECT 1", false);
    read("EXPLAIN ANALYZE SELECT 1", false);
    read("PRAGMA version", false);
    read("PRAGMA table_info('t')", false);
    read("pragma database_size", false);
    read("USE other", false);
    read("use main.other", false);
  });

  it("treats EXPLAIN of a write and PRAGMA assignments as writes", () => {
    write("EXPLAIN DELETE FROM t");
    write("PRAGMA memory_limit='1GB'");
  });

  it("rejects writes and side-effecting statements", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
      "TRUNCATE t",
      "CREATE TABLE t (a INT)",
      "CREATE OR REPLACE VIEW v AS SELECT 1",
      "DROP TABLE t",
      "ALTER TABLE t ADD COLUMN b INT",
      "COPY t TO 'out.parquet'",
      "COPY (SELECT 1) TO '/tmp/x.csv'",
      "EXPORT DATABASE 'dir'",
      "IMPORT DATABASE 'dir'",
      "ATTACH 'other.db' AS other",
      "DETACH other",
      "INSTALL httpfs",
      "FORCE INSTALL httpfs",
      "LOAD httpfs",
      "SET memory_limit = '1GB'",
      "SET gizmosql.query_timeout = 0",
      "RESET memory_limit",
      "CALL start_ui()",
      "BEGIN TRANSACTION",
      "COMMIT",
      "ROLLBACK",
      "CHECKPOINT",
      "VACUUM",
      "ANALYZE",
      "KILL SESSION 'x'",
    ]) {
      write(sql);
    }
  });

  it("marks unknown leading tokens as unknown", () => {
    assert.equal(classifyStatement("FROBNICATE t").kind, "unknown");
    assert.equal(classifyStatement("").kind, "unknown");
    assert.equal(classifyStatement("PIVOT t ON a").kind, "unknown");
    assert.equal(classifyStatement("WITH x AS SELECT 1").kind, "unknown");
  });
});

describe("guardStatement", () => {
  it("returns a normalized statement for allowed reads", () => {
    const g = guardStatement("  SELECT 1 -- comment\n;", false);
    assert.equal(g.sql, "SELECT 1");
    assert.equal(g.classification.kind, "read");
  });

  it("rejects empty, multi-statement, write and unknown input in read-only mode", () => {
    assert.throws(() => guardStatement("", false), SqlGuardError);
    assert.throws(() => guardStatement("-- only a comment", false), SqlGuardError);
    assert.throws(() => guardStatement("SELECT 1; DROP TABLE t", false), /Only one SQL statement/);
    assert.throws(() => guardStatement("DROP TABLE t", false), /read-only/);
    assert.throws(() => guardStatement("FROBNICATE", false), /Unable to classify/);
  });

  it("allows writes (but still one statement) when writes are enabled", () => {
    assert.equal(guardStatement("DROP TABLE t;", true).classification.kind, "write");
    assert.throws(() => guardStatement("DROP TABLE t; DROP TABLE u", true), /Only one SQL statement/);
    assert.equal(guardStatement("FROBNICATE", true).classification.kind, "unknown");
  });
});

describe("normalizeStatement / wrapWithLimit", () => {
  it("strips comments and trailing semicolons before wrapping", () => {
    const sql = normalizeStatement("SELECT 1 AS a; -- done");
    assert.equal(sql, "SELECT 1 AS a");
    assert.equal(wrapWithLimit(sql, 11), "SELECT * FROM (\nSELECT 1 AS a\n) AS gizmosql_mcp_q LIMIT 11");
  });

  it("rejects non-positive limits", () => {
    assert.throws(() => wrapWithLimit("SELECT 1", 0), SqlGuardError);
  });
});
