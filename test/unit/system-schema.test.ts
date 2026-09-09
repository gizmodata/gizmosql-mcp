import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSystemSchema, isTransientSchema } from "../../dist/server.js";

describe("isSystemSchema", () => {
  it("matches DuckDB and Postgres-compatibility schemas", () => {
    for (const name of ["information_schema", "pg_catalog", "pg_toast", "pg_temp_3", "pg_toast_temp_180", "PG_CATALOG"]) {
      assert.equal(isSystemSchema(name), true, name);
    }
  });

  it("tells per-backend Postgres temp schemas apart from the rest", () => {
    for (const name of ["pg_temp_3", "pg_toast_temp_180", "PG_TEMP_1"]) assert.equal(isTransientSchema(name), true, name);
    for (const name of ["information_schema", "pg_catalog", "pg_toast", "main", "pg_temp", "sales_pg_temp_1"]) {
      assert.equal(isTransientSchema(name), false, name);
    }
  });

  it("keeps user schemas", () => {
    for (const name of ["main", "public", "pg_data", "pgtemp", "temp", "information", "sales_pg_temp_1"]) {
      assert.equal(isSystemSchema(name), false, name);
    }
  });
});
