// Per-user sessions for the HTTP transport.
//
// Every authenticated caller gets their own ConnectionRegistry, i.e. their own
// GizmoSQL connections, current-connection choice and search path (USE), so
// use_schema / use_connection / USE never leak between people sharing one
// pod. Sessions are created on first use, refreshed on every request, and
// closed after an idle period or when the pool is full (least recently used
// first). The credentials are still the configured service account; only the
// session state is per user.

import type { McpConfig } from "./connection.js";
import { ConnectionRegistry } from "./registry.js";

export interface SessionInfo {
  key: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
}

interface Entry extends SessionInfo {
  registry: ConnectionRegistry;
}

export interface SessionStoreOptions {
  /** Seconds without a request after which a session is closed. */
  idleSeconds: number;
  /** Upper bound on concurrent sessions; the least recently used is closed to make room. */
  maxSessions: number;
  log?: (message: string) => void;
  /** Test hook: clock. */
  now?: () => number;
  /** Sweep period; defaults to half the idle time, at most one minute. Zero disables the timer. */
  sweepIntervalMs?: number;
}

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly config: McpConfig,
    readonly options: SessionStoreOptions,
  ) {
    this.log = options.log ?? ((m) => console.error(m));
    this.now = options.now ?? (() => Date.now());
    const interval = options.sweepIntervalMs ?? Math.min(60_000, Math.max(1_000, (options.idleSeconds * 1000) / 2));
    if (interval > 0) {
      this.timer = setInterval(() => void this.sweep(), interval);
      this.timer.unref();
    }
  }

  /** Returns the caller's registry, creating it on first use and marking it as used now. */
  acquire(key: string, label: string): { registry: ConnectionRegistry; info: SessionInfo } {
    if (this.closed) throw new Error("session store is closed");
    const t = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      this.evictToFit();
      const registry = new ConnectionRegistry(this.config, (m) => this.log(`${m} [${label}]`));
      entry = { key, label, createdAt: new Date(t), lastUsedAt: new Date(t), registry };
      this.entries.set(key, entry);
      this.log(`[gizmosql-mcp] session opened for ${label} (${this.entries.size} active)`);
    } else {
      entry.lastUsedAt = new Date(t);
      // Refresh insertion order so Map iteration stays least-recently-used first.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return { registry: entry.registry, info: { key, label, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt } };
  }

  size(): number {
    return this.entries.size;
  }

  sessions(): SessionInfo[] {
    return [...this.entries.values()].map(({ key, label, createdAt, lastUsedAt }) => ({ key, label, createdAt, lastUsedAt }));
  }

  /** Closes sessions idle for longer than the configured period. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.options.idleSeconds * 1000;
    const stale = [...this.entries.values()].filter((e) => e.lastUsedAt.getTime() <= cutoff);
    await Promise.all(stale.map((e) => this.evict(e, "idle")));
  }

  /** Closes every session (shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.entries.values()].map((e) => this.evict(e, "shutdown")));
  }

  private evictToFit(): void {
    while (this.entries.size >= this.options.maxSessions) {
      const oldest = this.entries.values().next().value as Entry | undefined;
      if (!oldest) break;
      void this.evict(oldest, "pool full");
    }
  }

  private async evict(entry: Entry, reason: string): Promise<void> {
    if (!this.entries.delete(entry.key)) return;
    this.log(`[gizmosql-mcp] session closed for ${entry.label} (${reason}; ${this.entries.size} active)`);
    await entry.registry.close().catch(() => undefined);
  }
}
