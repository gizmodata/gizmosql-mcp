import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeError, stripTransportNoise } from "../../dist/server.js";

describe("stripTransportNoise", () => {
  it("removes the driver, Arrow and Flight SQL wrappers around a DuckDB error", () => {
    const raw =
      "Arrow Error: C Data interface error: [FlightSQL] An execution error has occurred: " +
      "Invalid Input Error: Values were not provided for the following prepared statement parameters: 2 " +
      "(Unknown; DoGet: endpoint 0: [])";
    assert.equal(
      stripTransportNoise(raw),
      "Invalid Input Error: Values were not provided for the following prepared statement parameters: 2",
    );
    assert.equal(stripTransportNoise("Failed to execute query: Binder Error: no such column"), "Binder Error: no such column");
  });

  it("leaves ordinary messages and parenthesised content alone", () => {
    assert.equal(stripTransportNoise("Catalog Error: Table with name t does not exist (did you mean x?)"), "Catalog Error: Table with name t does not exist (did you mean x?)");
    assert.equal(stripTransportNoise("  plain  "), "plain");
  });

  it("is applied by describeError with redaction", () => {
    const msg = describeError(new Error("[FlightSQL] An execution error has occurred: password is hunter2 (Unknown; DoGet: endpoint 0: [])"), (t) =>
      t.replace("hunter2", "***"),
    );
    assert.equal(msg, "password is ***");
  });
});
