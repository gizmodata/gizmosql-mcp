// Every advertised tool schema must be JSON Schema 2020-12: the MCP SDK
// stamps draft-07 by default (typescript-sdk #2721) and strict hosts such as
// Claude Desktop reject tools declaring that dialect before calling them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../../dist/connection.js";
import { ConnectionRegistry } from "../../dist/registry.js";
import { createServer } from "../../dist/server.js";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

async function listTools(env: Record<string, string>) {
  const config = parseConfig({ GIZMOSQL_HOST: "db.internal", GIZMOSQL_USERNAME: "u", GIZMOSQL_PASSWORD: "p", ...env });
  const registry = new ConnectionRegistry(config, () => undefined);
  const server = createServer({ registry, config, transport: "stdio" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tool schema dialect", () => {
  it("advertises every input and output schema as JSON Schema 2020-12", async () => {
    const tools = await listTools({ GIZMOSQL_ALLOW_WRITES: "true", GIZMOSQL_ENABLE_SSO: "true" });
    assert.ok(tools.length >= 12, `expected the full tool set, got ${tools.map((t) => t.name).join(", ")}`);
    for (const tool of tools) {
      const input = tool.inputSchema as { $schema?: string };
      assert.equal(input.$schema, JSON_SCHEMA_2020_12, `${tool.name} inputSchema`);
      if (tool.outputSchema) {
        const output = tool.outputSchema as { $schema?: string };
        assert.equal(output.$schema, JSON_SCHEMA_2020_12, `${tool.name} outputSchema`);
      }
    }
    const runQuery = tools.find((t) => t.name === "run_query");
    assert.ok(runQuery?.outputSchema, "run_query declares an outputSchema");
  });
});
