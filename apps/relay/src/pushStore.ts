import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  registeredAt: number;
  lastUsedAt: number;
}

interface PushStoreConfig {
  /** Absolute or relative path to the JSON snapshot. */
  path?: string;
  /** Coalesce writes within this many ms. Default 500. */
  flushDebounceMs?: number;
}

interface Snapshot {
  version: 1;
  entries: Record<string, PushSubscriptionRecord[]>;
}

/**
 * Persists Web Push subscriptions keyed by an agent's Ed25519 signing public key.
 *
 * Each agent can have multiple paired PWAs, so the store keeps a list of
 * subscriptions per agent. Writes are debounced to avoid stat/write churn when
 * many subscriptions are added in quick succession.
 */
export class PushStore {
  private entries = new Map<string, PushSubscriptionRecord[]>();
  private path: string | undefined;
  private flushDebounceMs: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: PushStoreConfig = {}) {
    this.path = config.path;
    this.flushDebounceMs = config.flushDebounceMs ?? 500;
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const data = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(data) as Snapshot;
      if (parsed.version !== 1 || typeof parsed.entries !== 'object') return;
      for (const [agentKey, subs] of Object.entries(parsed.entries)) {
        if (Array.isArray(subs)) this.entries.set(agentKey, subs);
      }
    } catch (err) {
      console.error('[pushStore] failed to load snapshot:', err);
    }
  }

  private scheduleFlush(): void {
    if (!this.path) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.flushDebounceMs);
    // Don't keep the event loop alive just for a debounced flush.
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    if (!this.path) return;
    try {
      const snapshot: Snapshot = {
        version: 1,
        entries: Object.fromEntries(this.entries),
      };
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(snapshot));
    } catch (err) {
      console.error('[pushStore] failed to write snapshot:', err);
    }
  }

  /** Flush any pending writes synchronously. Used on shutdown. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
  }

  add(agentKey: string, sub: PushSubscriptionRecord): void {
    const list = this.entries.get(agentKey) ?? [];
    const idx = list.findIndex((s) => s.endpoint === sub.endpoint);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...sub, lastUsedAt: sub.lastUsedAt };
    } else {
      list.push(sub);
    }
    this.entries.set(agentKey, list);
    this.scheduleFlush();
  }

  /** Remove a subscription by endpoint, optionally scoped to one agent. */
  removeByEndpoint(endpoint: string, agentKey?: string): boolean {
    let removed = false;
    const keys = agentKey ? [agentKey] : [...this.entries.keys()];
    for (const key of keys) {
      const list = this.entries.get(key);
      if (!list) continue;
      const filtered = list.filter((s) => s.endpoint !== endpoint);
      if (filtered.length !== list.length) {
        removed = true;
        if (filtered.length === 0) this.entries.delete(key);
        else this.entries.set(key, filtered);
      }
    }
    if (removed) this.scheduleFlush();
    return removed;
  }

  list(agentKey: string): PushSubscriptionRecord[] {
    return this.entries.get(agentKey)?.slice() ?? [];
  }

  touch(agentKey: string, endpoint: string, now: number): void {
    const list = this.entries.get(agentKey);
    if (!list) return;
    const sub = list.find((s) => s.endpoint === endpoint);
    if (sub) {
      sub.lastUsedAt = now;
      this.scheduleFlush();
    }
  }

  get stats() {
    let total = 0;
    for (const subs of this.entries.values()) total += subs.length;
    return { agents: this.entries.size, subscriptions: total };
  }
}
