// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { WebSocket } from 'ws';
import { sendMessage } from '@sumicom/ws-relay';

/**
 * Tracks which agent WebSocket connections want push notifications for
 * tombstone writes on a given mailbox (`keyHash`).
 *
 * Subscriptions are soft-state: they die with the underlying WS — callers
 * must invoke `unsubscribeAll(ws)` on peer disconnect so we don't leak closed
 * sockets. `publish` is called from the sync-tombstone PUT handler once the
 * signed tombstone lands in the store.
 *
 * The relay does NOT verify the tombstone itself here; that's the agent's job
 * (it has the pinned peer Ed25519 pubkey). Relay just fans it out. Attacker
 * forgery on the wire still requires the group's `masterSecret`, so a
 * malicious tombstone emitted here would fail the agent's verify step and be
 * discarded — identical to the catch-up GET behaviour.
 */
export class TombstoneSubs {
  private byKey = new Map<string, Set<WebSocket>>();

  /**
   * Add `ws` as a subscriber on `keyHash`. Idempotent. No-op if the socket is
   * already past OPEN (defensive: caller may have raced with disconnect).
   */
  subscribe(keyHash: string, ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    let set = this.byKey.get(keyHash);
    if (!set) {
      set = new Set();
      this.byKey.set(keyHash, set);
    }
    set.add(ws);
  }

  /** Remove `ws` from `keyHash`. Drops the entry if empty. */
  unsubscribe(keyHash: string, ws: WebSocket): void {
    const set = this.byKey.get(keyHash);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.byKey.delete(keyHash);
  }

  /** Remove `ws` from every `keyHash`. Call on peer disconnect. */
  unsubscribeAll(ws: WebSocket): void {
    for (const [keyHash, set] of this.byKey) {
      if (set.delete(ws) && set.size === 0) {
        this.byKey.delete(keyHash);
      }
    }
  }

  /**
   * Fan out a `tombstone-event` to every currently-subscribed socket on
   * `keyHash`. Sockets that have closed since subscribe are dropped lazily.
   */
  publish(keyHash: string, data: string): void {
    const set = this.byKey.get(keyHash);
    if (!set) return;
    const dead: WebSocket[] = [];
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) {
        dead.push(ws);
        continue;
      }
      sendMessage(ws, {
        type: 'tombstone-event',
        payload: { keyHash, data },
      });
    }
    for (const ws of dead) set.delete(ws);
    if (set.size === 0) this.byKey.delete(keyHash);
  }

  /** Visible for tests + `/stats`. */
  get stats(): { keys: number; subscribers: number } {
    let subscribers = 0;
    for (const set of this.byKey.values()) subscribers += set.size;
    return { keys: this.byKey.size, subscribers };
  }

  /** Visible for tests. */
  subscriberCount(keyHash: string): number {
    return this.byKey.get(keyHash)?.size ?? 0;
  }
}
