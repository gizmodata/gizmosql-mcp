// Every tool result carries `_meta.gizmosql_mcp` identifying the build.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../../dist/connection.js";
import { ConnectionRegistry } from "../../dist/registry.js";
import { createServer } from "../../dist/server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../dist/version.js";

describe("result envelope", () => {
  it("stamps _meta.gizmosql_mcp on success and error results", async () => {
    const config = parseConfig({ GIZMOSQL_HOST: "db.internal", GIZMOSQL_USERNAME: "u", GIZMOSQL_PASSWORD: "p" });
    const registry = new ConnectionRegistry(config, () => undefined);
    const server = createServer({ registry, config, transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const expected = { gizmosql_mcp: { name: PACKAGE_NAME, version: PACKAGE_VERSION } };
      const ok = await client.callTool({ name: "list_connections", arguments: {} });
      assert.equal(ok.isError, undefined);
      assert.deepEqual(ok._meta, expected);
      const failed = await client.callTool({ name: "use_connection", arguments: { name: "nope" } });
      assert.equal(failed.isError, true);
      assert.deepEqual(failed._meta, expected);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
