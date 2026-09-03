// Registry of named GizmoSQL connections with a switchable default.

import { GizmoConnection, redactSecrets, type ConnectionConfig, type McpConfig } from "./connection.js";

export class UnknownConnectionError extends Error {
  constructor(name: string, available: string[]) {
    super(`Unknown connection "${name}". Available connections: ${available.join(", ")}.`);
    this.name = "UnknownConnectionError";
  }
}

export interface ConnectionSummary {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  auth: string;
  default_catalog: string | null;
  default_schema: string | null;
  current: boolean;
  connected: boolean;
}

/**
 * Holds one lazily opened GizmoConnection per configured server. Names are
 * matched case-insensitively. The first configured connection is the
 * initial default; `use()` switches it for the rest of the process.
 */
export class ConnectionRegistry {
  private readonly byName = new Map<string, GizmoConnection>();
  private readonly order: string[] = [];
  private currentName: string;

  constructor(
    readonly config: McpConfig,
    log: (message: string) => void = (m) => console.error(m),
  ) {
    if (config.connections.length === 0) throw new Error("At least one connection is required.");
    for (const c of config.connections) {
      const conn = new GizmoConnection(c, (m) => log(config.connections.length > 1 ? `${m} [${c.name}]` : m));
      this.byName.set(c.name.toLowerCase(), conn);
      this.order.push(c.name);
    }
    this.currentName = config.connections[0].name;
  }

  /** Names in configuration order. */
  names(): string[] {
    return [...this.order];
  }

  /** Name of the current default connection. */
  current(): string {
    return this.currentName;
  }

  has(name: string): boolean {
    return this.byName.has(name.trim().toLowerCase());
  }

  /** Resolves a connection by name (case-insensitive); undefined/blank means the current default. */
  get(name?: string): GizmoConnection {
    const key = (name ?? "").trim();
    if (key === "") return this.byName.get(this.currentName.toLowerCase())!;
    const conn = this.byName.get(key.toLowerCase());
    if (!conn) throw new UnknownConnectionError(key, this.order);
    return conn;
  }

  /** Makes `name` the default for subsequent calls; returns its canonical name. */
  use(name: string): string {
    const conn = this.get(name);
    this.currentName = conn.config.name;
    return this.currentName;
  }

  all(): GizmoConnection[] {
    return this.order.map((n) => this.byName.get(n.toLowerCase())!);
  }

  configFor(name?: string): ConnectionConfig {
    return this.get(name).config;
  }

  /** Every secret from every connection plus the HTTP bearer token. */
  secrets(): Array<string | undefined> {
    return [...this.all().flatMap((c) => c.secrets()), this.config.mcpBearerToken];
  }

  redact(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  summaries(): ConnectionSummary[] {
    return this.all().map((c) => {
      const auth = c.effectiveAuth();
      return {
        name: c.config.name,
        host: c.config.host,
        port: c.config.port,
        tls: !c.config.plaintext,
        auth: auth.method === "password" ? `password (${auth.user ?? ""})` : auth.method,
        default_catalog: c.currentSearchPath().catalog ?? null,
        default_schema: c.currentSearchPath().schema ?? null,
        current: c.config.name === this.currentName,
        connected: c.connectedAt !== null,
      };
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.all().map((c) => c.close().catch(() => undefined)));
  }
}
