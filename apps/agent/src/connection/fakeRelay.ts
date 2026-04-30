// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';

/**
 * In-memory model of the production relay (apps/relay) for tests. Mirrors the
 * routing + signaling behaviors that agent and PWA actually depend on:
 *
 * - Routes JSON envelopes shaped `{from, to, payload}` between two attached
 *   peers, dropping the envelope if `to` is offline.
 * - PWA `watch-agent` subscribes to an agent's online status. The hub
 *   immediately replies with `agent-status` for the watched agent, and pushes
 *   another `agent-status` whenever that agent connects or disconnects.
 * - When a watched PWA disconnects, the hub pushes `pwa-bye` to the agent.
 * - Agent `tombstone-subscribe` / `tombstone-unsubscribe` are remembered so a
 *   subsequent `publishTombstone()` fans out a `tombstone-event` to every
 *   matching agent.
 *
 * Out of scope: rate limiting, gzip envelope `{z}` (we don't unwrap because
 * the relay doesn't either — it forwards bytes blindly), blob store, key
 * validation. Those layers are tested elsewhere or not relevant to the
 * agent↔PWA wire flows we're modeling.
 *
 * The hub is intentionally synchronous-with-microtask-queue: a `send()` call
 * delivers via `queueMicrotask` so message ordering is preserved while still
 * surfacing race conditions that would only appear under async dispatch.
 */

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface FakeRelayPeer {
  channel: 'agent' | 'pwa';
  id: string;
  /** Routing address as the relay would render it: e.g. `agent:abc` / `pwa:xyz`. */
  address: string;
  socket: FakeWsSocket;
}

/** Subset of the `ws` WebSocket API that `relay.ts` uses. */
export class FakeWsSocket extends EventEmitter {
  readyState = WS_OPEN;
  /** Set by the hub during `attach`; null once closed. */
  private hub: FakeRelayHub | null;
  private address: string;

  constructor(hub: FakeRelayHub, address: string) {
    super();
    // Avoid spurious "max listeners" warnings from heartbeat reattaches.
    this.setMaxListeners(50);
    this.hub = hub;
    this.address = address;
  }

  send(data: string | Buffer | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== WS_OPEN) return;
    const hub = this.hub;
    if (!hub) return;
    queueMicrotask(() => hub._handleClientSend(this.address, data));
  }

  ping(): void {
    if (this.readyState !== WS_OPEN) return;
    queueMicrotask(() => this.emit('pong'));
  }

  terminate(): void {
    this._close('terminate');
  }

  close(): void {
    this._close('close');
  }

  /**
   * Internal: deliver a frame from the hub to this socket. Always async via
   * microtask so the hub stays consistent and listeners can attach in order.
   */
  _deliver(payload: string | Buffer): void {
    if (this.readyState !== WS_OPEN) return;
    queueMicrotask(() => {
      if (this.readyState !== WS_OPEN) return;
      this.emit('message', payload);
    });
  }

  /**
   * Internal: simulate the relay closing this socket. Fires `close` once.
   * No-op on repeat. The `reason` is informational only.
   */
  _close(_reason: string): void {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    this.readyState = WS_CLOSING;
    const hub = this.hub;
    this.hub = null;
    if (hub) hub._removePeer(this.address);
    this.readyState = WS_CLOSED;
    queueMicrotask(() => this.emit('close'));
  }
}

interface AgentSubscription {
  // Set of PWA addresses watching this agent.
  watchers: Set<string>;
}

interface TombstoneSubscription {
  // Set of agent addresses subscribed to this keyHash.
  subscribers: Set<string>;
}

export class FakeRelayHub {
  private peers = new Map<string, FakeRelayPeer>();
  private agentWatchers = new Map<string /*agentId*/, AgentSubscription>();
  private tombstoneSubs = new Map<
    string /*keyHash*/,
    TombstoneSubscription
  >();
  /** Most-recent tombstone payload per keyHash for late-subscriber replay. */
  private tombstonePayloads = new Map<string /*keyHash*/, string>();

  /** Register an agent peer at `agent:{agentId}`. Throws on duplicate. */
  attachAgent(agentId: string): FakeWsSocket {
    const address = `agent:${agentId}`;
    if (this.peers.has(address)) {
      throw new Error(`FakeRelayHub: agent ${agentId} already attached`);
    }
    const socket = new FakeWsSocket(this, address);
    this.peers.set(address, { channel: 'agent', id: agentId, address, socket });
    // Notify any PWAs already watching this agent that it is now online.
    const sub = this.agentWatchers.get(agentId);
    if (sub) {
      for (const watcher of sub.watchers) {
        this._sendSignal(watcher, {
          type: 'agent-status',
          payload: { agentId, online: true },
        });
      }
    }
    queueMicrotask(() => socket.emit('open'));
    return socket;
  }

  /**
   * Register a PWA peer at `pwa:{connectionId}`. The relay's `pwa` channel
   * decodes percent-encoded ids; we accept whatever the test passes. Throws
   * on duplicate id (the prod relay's `pwa` channel uses 'replace' semantics
   * but the duplicate case isn't relevant for the e2e flows we model here).
   */
  attachPwa(connectionId: string): FakeWsSocket {
    const address = `pwa:${connectionId}`;
    if (this.peers.has(address)) {
      throw new Error(`FakeRelayHub: pwa ${connectionId} already attached`);
    }
    const socket = new FakeWsSocket(this, address);
    this.peers.set(address, {
      channel: 'pwa',
      id: connectionId,
      address,
      socket,
    });
    queueMicrotask(() => socket.emit('open'));
    return socket;
  }

  /**
   * Test hook: simulate the relay receiving a tombstone for `keyHash` and
   * fanning it out to every subscribed agent. Mirrors the real relay's HTTP
   * upload path → `tombstoneSubs.publish`.
   */
  publishTombstone(keyHash: string, ciphertext: string): void {
    this.tombstonePayloads.set(keyHash, ciphertext);
    const sub = this.tombstoneSubs.get(keyHash);
    if (!sub) return;
    for (const subscriber of sub.subscribers) {
      this._sendSignal(subscriber, {
        type: 'tombstone-event',
        payload: { keyHash, data: ciphertext },
      });
    }
  }

  /** Number of currently attached peers in either channel. */
  peerCount(): number {
    return this.peers.size;
  }

  /** Inspect attached peers for assertions. */
  listPeers(): FakeRelayPeer[] {
    return Array.from(this.peers.values());
  }

  /**
   * Tear everything down. Fires `close` on each peer socket. Tests should
   * call this in `afterEach` to keep state isolated.
   */
  close(): void {
    for (const peer of Array.from(this.peers.values())) {
      peer.socket._close('hub-close');
    }
    this.peers.clear();
    this.agentWatchers.clear();
    this.tombstoneSubs.clear();
    this.tombstonePayloads.clear();
  }

  // -------------------------------------------------------------------------
  // Internals — driven by FakeWsSocket and tests
  // -------------------------------------------------------------------------

  _handleClientSend(
    fromAddress: string,
    raw: string | Buffer | ArrayBuffer | Uint8Array,
  ): void {
    const peer = this.peers.get(fromAddress);
    if (!peer) return;

    // The relay forwards opaque bytes; we only inspect JSON for control
    // messages. If parsing fails we treat the frame as a routed-but-malformed
    // frame and drop it (the prod relay would also drop a non-JSON, non-
    // routed frame).
    const text = bufferToString(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const obj = parsed as Record<string, unknown>;

    // Routed envelope: forward to `to` if attached, otherwise drop.
    if (
      typeof obj.from === 'string' &&
      typeof obj.to === 'string' &&
      'payload' in obj
    ) {
      const target = this.peers.get(obj.to);
      if (!target) return;
      target.socket._deliver(text);
      return;
    }

    // Control messages.
    const type = obj.type;
    if (peer.channel === 'pwa' && type === 'watch-agent') {
      const agentId = obj.agentId;
      if (typeof agentId !== 'string') return;
      let sub = this.agentWatchers.get(agentId);
      if (!sub) {
        sub = { watchers: new Set() };
        this.agentWatchers.set(agentId, sub);
      }
      sub.watchers.add(peer.address);
      const online = this.peers.has(`agent:${agentId}`);
      this._sendSignal(peer.address, {
        type: 'agent-status',
        payload: { agentId, online },
      });
      return;
    }

    if (peer.channel === 'agent' && type === 'tombstone-subscribe') {
      const payload = obj.payload as { keyHash?: string } | undefined;
      const keyHash = payload?.keyHash;
      if (typeof keyHash !== 'string') return;
      let sub = this.tombstoneSubs.get(keyHash);
      if (!sub) {
        sub = { subscribers: new Set() };
        this.tombstoneSubs.set(keyHash, sub);
      }
      sub.subscribers.add(peer.address);
      // Replay last seen tombstone so a late subscriber catches up.
      const replay = this.tombstonePayloads.get(keyHash);
      if (replay) {
        this._sendSignal(peer.address, {
          type: 'tombstone-event',
          payload: { keyHash, data: replay },
        });
      }
      return;
    }

    if (peer.channel === 'agent' && type === 'tombstone-unsubscribe') {
      const payload = obj.payload as { keyHash?: string } | undefined;
      const keyHash = payload?.keyHash;
      if (typeof keyHash !== 'string') return;
      const sub = this.tombstoneSubs.get(keyHash);
      sub?.subscribers.delete(peer.address);
      if (sub && sub.subscribers.size === 0) this.tombstoneSubs.delete(keyHash);
      return;
    }
    // Anything else: silently drop. The prod relay's `onMessage` returns
    // undefined for unrecognised non-routed JSON and the default legacy
    // handler is not configured here.
  }

  _removePeer(address: string): void {
    const peer = this.peers.get(address);
    if (!peer) return;
    this.peers.delete(address);

    if (peer.channel === 'agent') {
      const sub = this.agentWatchers.get(peer.id);
      if (sub) {
        for (const watcher of sub.watchers) {
          this._sendSignal(watcher, {
            type: 'agent-status',
            payload: { agentId: peer.id, online: false },
          });
        }
      }
      // Drop tombstone subscriptions held by this agent.
      for (const [keyHash, sub2] of this.tombstoneSubs) {
        sub2.subscribers.delete(peer.address);
        if (sub2.subscribers.size === 0) this.tombstoneSubs.delete(keyHash);
      }
    }

    if (peer.channel === 'pwa') {
      // Notify every agent currently watched by this PWA.
      for (const [agentId, sub] of this.agentWatchers) {
        if (sub.watchers.delete(peer.address)) {
          if (sub.watchers.size === 0) this.agentWatchers.delete(agentId);
          const agentPeer = this.peers.get(`agent:${agentId}`);
          if (agentPeer) {
            this._sendSignal(agentPeer.address, {
              type: 'pwa-bye',
              payload: { pwaAddress: peer.address },
            });
          }
        }
      }
    }
  }

  private _sendSignal(toAddress: string, message: object): void {
    const target = this.peers.get(toAddress);
    if (!target) return;
    target.socket._deliver(JSON.stringify(message));
  }
}

function bufferToString(
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf-8');
  return Buffer.from(raw).toString('utf-8');
}

// ---------------------------------------------------------------------------
// `ws` module mock helper
// ---------------------------------------------------------------------------

/**
 * Singleton hub the mocked `ws` constructor routes new sockets to. Tests set
 * this in `beforeEach` and clear it in `afterEach` so each test gets a fresh
 * relay state.
 */
let activeHub: FakeRelayHub | null = null;

export function setActiveFakeRelayHub(hub: FakeRelayHub | null): void {
  activeHub = hub;
}

export function getActiveFakeRelayHub(): FakeRelayHub | null {
  return activeHub;
}

/**
 * Constructor that satisfies `new WebSocket(url)` for the production
 * `relay.ts` code path. Picks the channel + id off the URL path; the URL
 * scheme/host is ignored (e.g. `ws://test/agent/abc` → channel=agent, id=abc).
 *
 * Use with `vi.mock('ws', () => ({ default: FakeWebSocket }))` — vitest
 * resolves the mock at module-load time, so `setActiveFakeRelayHub` must run
 * before the production code instantiates a socket.
 */
export const FakeWebSocket: new (url: string) => FakeWsSocket =
  function FakeWebSocket(url: string): FakeWsSocket {
    const hub = activeHub;
    if (!hub) {
      throw new Error(
        'FakeWebSocket: no active FakeRelayHub. Call setActiveFakeRelayHub() ' +
          'in your test setup before constructing a WebSocket.',
      );
    }
    const path = parseWsPath(url);
    if (path.channel === 'agent') return hub.attachAgent(path.id);
    if (path.channel === 'pwa') return hub.attachPwa(path.id);
    throw new Error(`FakeWebSocket: unsupported channel "${path.channel}"`);
  } as unknown as new (url: string) => FakeWsSocket;

// Mirror the static `WebSocket.OPEN` etc. constants that `relay.ts` reads.
(FakeWebSocket as unknown as { OPEN: number }).OPEN = WS_OPEN;
(FakeWebSocket as unknown as { CLOSING: number }).CLOSING = WS_CLOSING;
(FakeWebSocket as unknown as { CLOSED: number }).CLOSED = WS_CLOSED;

function parseWsPath(url: string): { channel: string; id: string } {
  // Last two non-empty path segments are channel/id.
  const noScheme = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const segments = noScheme.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new Error(`FakeWebSocket: malformed url "${url}"`);
  }
  const id = segments[segments.length - 1];
  const channel = segments[segments.length - 2];
  return { channel, id: decodeURIComponent(id) };
}
