import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import {
  generateKeyPair,
  generateSigningKeyPair,
  encodeKeyPair,
  encodeBase64,
  decodeBase64,
  generateSessionDEK,
  encryptDEK,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  signKeyExchangeV2,
  parseMessage,
  serializeMessage,
  createMessage,
  type AgentId,
  type CardEvent,
  type CardStreamEnd,
  type CardHistoryResponse,
  type ClaudePreferences,
  type ConfigValue,
  type KeyPair,
  type Message,
  type SessionCardsUpdate,
  type SessionConfigUpdatedPayload,
  type SessionUpdatePayload,
} from '@sumicom/quicksave-shared';
import {
  MessageBusClient,
  MessageBusServer,
  type ClientFrame,
  type ClientTransport,
  type ServerFrame,
} from '@sumicom/quicksave-message-bus';

import { AgentConnection } from './connection.js';
import { BusServerTransport } from '../messageBus/busServerTransport.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderHistoryMode,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from '../ai/provider.js';
import type { SessionManager } from '../ai/sessionManager.js';
import type { StreamCardBuilder } from '../ai/cardBuilder.js';
import type { FakeRelayHub, FakeWsSocket } from './fakeRelay.js';

/**
 * E2E test harness: spins up a real `AgentConnection` + `MessageBusServer`
 * over a `FakeRelayHub`, and a real PWA-side `MessageBusClient` whose
 * transport rides through the relay+encryption layers exactly like prod.
 *
 * Setup (per test file) requires three vi.mocks at the top:
 *
 * ```ts
 * vi.mock('ws', () => ({ default: FakeWebSocket, WebSocket: FakeWebSocket }));
 * vi.mock('../tombstoneCheck.js', () => ({
 *   checkTombstone: vi.fn().mockResolvedValue({ status: 'absent' }),
 *   hashPublicKey: vi.fn((pk: string) => `hash-${pk.slice(0, 8)}`),
 *   verifyTombstonePayload: vi.fn(),
 * }));
 * ```
 *
 * Plus a per-test temp `QUICKSAVE_HOME` (via `setQuicksaveDir`) so the real
 * `config.ts` can write the agent's identity without colliding across tests.
 *
 * What this harness exercises end-to-end on the agent side:
 * - `relay.ts` ws framing (compressed `{z}`, routed envelopes, signaling
 *   types like `pwa-bye` and `agent-status`)
 * - `connection.ts` V2 key-exchange validation, TOFU pinning, DEK
 *   encryption / decryption, gzip + base64 framing, send-queue ordering
 * - `BusServerTransport` ↔ `MessageBusServer` command/subscribe routing
 *
 * Out of scope (use other tests):
 * - Tombstone HTTP catch-up path (mocked here, exercised in tombstoneCheck.test.ts)
 * - PWA UI / store wiring (this harness sits at the bus layer)
 * - Reconnect timing and exponential backoff (covered by relay.fakeHub.test.ts)
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------
// Agent side
// ---------------------------------------------------------------------------

export interface AgentSide {
  agentId: string;
  /** Base64-encoded box public key (X25519). */
  publicKeyB64: string;
  connection: AgentConnection;
  bus: MessageBusServer;
  transport: BusServerTransport;
  /** Open the relay-side socket and start signaling. */
  start(): Promise<void>;
  /** Tear down the connection. */
  stop(): void;
}

export interface AgentBuildOpts {
  agentId: string;
  agentKeyPair: { publicKey: string; secretKey: string };
  signalingServer?: string;
}

/**
 * Wire up `AgentConnection` + `BusServerTransport` + `MessageBusServer` for
 * a single test agent. The caller is responsible for:
 *   1. Calling `setQuicksaveDir(tempDir)` first
 *   2. Calling `createDefaultConfig(...)` (or hand-crafting a config) so
 *      `loadConfig()` returns the same `{agentId, keyPair}` we pass in here
 *   3. Mocking `'ws'` so `relay.ts`'s `new WebSocket(...)` reaches the hub
 *
 * Returns the live agent objects. After `start()` resolves, the agent is
 * connected to the hub and waiting for a PWA to drive key-exchange.
 */
export function buildAgent(opts: AgentBuildOpts): AgentSide {
  const connection = new AgentConnection({
    signalingServer: opts.signalingServer ?? 'ws://test',
    agentId: opts.agentId,
    keyPair: opts.agentKeyPair,
  });
  const transport = new BusServerTransport(connection);
  const bus = new MessageBusServer(transport);

  return {
    agentId: opts.agentId,
    publicKeyB64: opts.agentKeyPair.publicKey,
    connection,
    bus,
    transport,
    async start() {
      await connection.start();
    },
    stop() {
      connection.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// PWA side
// ---------------------------------------------------------------------------

export interface FakePwaOpts {
  hub: FakeRelayHub;
  agentId: string;
  agentPublicKeyB64: string;
  /** Optional fixed connection id for predictable assertions. */
  connectionId?: string;
  /**
   * Inject a pre-generated Ed25519 signing keypair so multiple PWAs can
   * share a TOFU-pinned group identity. The agent pins the *first* PWA's
   * sigPubkey and rejects subsequent handshakes whose sigPubkey doesn't
   * match — the fix is to reuse the same keypair across PWAs in a test
   * (mirrors the prod model where every tab in a group derives from one
   * Ed25519 secret).
   */
  signKeyPair?: KeyPair;
}

/**
 * Stand-in for a PWA tab on the message bus. Performs a real V2 key
 * exchange against the agent (signing keypair + DEK encryption + base64
 * framing exactly as the real PWA does), then exposes a real
 * `MessageBusClient` whose transport pipes `bus:frame` envelopes through
 * the encrypted+gzipped channel.
 *
 * The client's connect/disconnect events fire after `start()` completes
 * so consumers can subscribe before issuing commands. Only one active
 * agent per `FakePwa` — multi-agent flows aren't modeled here.
 */
export class FakePwa {
  readonly connectionId: string;
  private hub: FakeRelayHub;
  private socket: FakeWsSocket | null = null;
  private agentId: string;
  private agentPublicKey: Uint8Array;
  private boxKeyPair: KeyPair;
  private signKeyPair: KeyPair;
  private sessionDEK: Uint8Array | null = null;
  /**
   * Mirrors `WebSocketClient.AgentSession.keyExchangeComplete`. The agent's
   * `key-exchange-ack` is delivered as plaintext JSON inside the routed
   * envelope — distinguished from encrypted bus frames by this flag, not by
   * inspecting the payload (the prod PWA does the same).
   */
  private keyExchangeComplete = false;
  private busTransport: FakePwaBusTransport;
  private busClient: MessageBusClient;
  private startPromise: Promise<void> | null = null;
  private events = new EventEmitter();
  /**
   * Serialize incoming routed-message processing so async decompress doesn't
   * resolve out of order, mirroring `WebSocketClient.messageQueue`.
   */
  private incomingQueue: Promise<void> = Promise.resolve();

  constructor(opts: FakePwaOpts) {
    this.hub = opts.hub;
    this.agentId = opts.agentId;
    this.agentPublicKey = decodeBase64(opts.agentPublicKeyB64);
    this.boxKeyPair = generateKeyPair();
    this.signKeyPair = opts.signKeyPair ?? generateSigningKeyPair();
    this.connectionId =
      opts.connectionId ?? `pwa-${Math.random().toString(36).slice(2, 10)}`;
    this.busTransport = new FakePwaBusTransport((frame) =>
      this.sendBusFrame(frame),
    );
    this.busClient = new MessageBusClient(this.busTransport);
  }

  /** Base64-encoded Ed25519 signing public key (the PWA group's TOFU anchor). */
  signingPublicKeyB64(): string {
    return encodeBase64(this.signKeyPair.publicKey);
  }

  /**
   * The Ed25519 signing keypair used for V2 key-exchange. Exposed so a test
   * can pass it to a second `FakePwa` to simulate multiple tabs sharing a
   * group identity (the agent TOFU-pins the first sigPubkey it sees and
   * rejects later handshakes that don't match).
   */
  groupSignKeyPair(): KeyPair {
    return this.signKeyPair;
  }

  /** Base64-encoded X25519 box public key (used to derive `pwa:{key}`). */
  boxPublicKeyB64(): string {
    return encodeBase64(this.boxKeyPair.publicKey);
  }

  /**
   * Attach to the relay, send `watch-agent`, complete key exchange, wait
   * for the ack. Resolves once the bus transport is `connected`. Idempotent.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // The hub address and the `from` field of every routed envelope MUST
    // match: the agent extracts `peerPWAPublicKey` from `from` to TOFU-pin
    // and replies routed to that exact address. We use `connectionId` for
    // both — by default it's `pwa-{random}`, which is opaque but stable.
    this.socket = this.hub.attachPwa(this.connectionId);
    await waitForOpen(this.socket);
    this.socket.on('message', (data: string | Buffer) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      this.incomingQueue = this.incomingQueue.then(() =>
        this.handleIncoming(text),
      );
    });
    this.socket.on('close', () => {
      this.busTransport._fireDisconnected();
    });

    // Watch the agent so the hub will tell us when it's online (or now).
    const ackPromise = new Promise<void>((resolve) =>
      this.events.once('key-exchange-ack', resolve),
    );
    this.sendRaw({ type: 'watch-agent', agentId: this.agentId });
    // The hub replies synchronously with `agent-status`. If the agent is
    // already attached we proceed to key-exchange immediately; otherwise we
    // wait for an `agent-status: online=true` push.
    await ackPromise;
    this.busTransport._fireConnected();
  }

  /**
   * Resolves when the next key-exchange ack is received. Used by reconnect
   * tests to wait for the agent to come back up after a hub-induced
   * disconnect.
   */
  waitForReconnect(): Promise<void> {
    return new Promise((resolve) =>
      this.events.once('key-exchange-ack', () => resolve()),
    );
  }

  /** The bus client. Use `command()`, `subscribe()`, etc. as in production. */
  bus(): MessageBusClient {
    return this.busClient;
  }

  /** Tear down. Idempotent. */
  close(): void {
    this.socket?.close();
    this.socket = null;
    this.startPromise = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleIncoming(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const obj = parsed as Record<string, unknown>;

    // Routed envelope from the agent: either key-exchange-ack JSON or an
    // encrypted bus frame.
    if (
      typeof obj.from === 'string' &&
      typeof obj.to === 'string' &&
      'payload' in obj
    ) {
      await this.handleRoutedPayload(obj.payload as string);
      return;
    }

    // Signaling messages from the relay.
    if (obj.type === 'agent-status') {
      const payload = obj.payload as { agentId: string; online: boolean };
      if (payload.agentId !== this.agentId) return;
      if (payload.online) {
        // Either first-time online or a reconnect — either way, start a
        // fresh V2 handshake. `startKeyExchange` resets DEK + the
        // `keyExchangeComplete` flag itself.
        await this.startKeyExchange();
      } else {
        // Agent went offline (relay closed its socket). Mirror the prod
        // PWA path: drop the session DEK so a stale-key encrypt can't
        // happen, mark the bus transport disconnected so the PWA's
        // `MessageBusClient.handleDisconnected` rejects in-flight commands
        // and marks subscriptions wireActive=false. The next online push
        // will trigger a fresh handshake.
        this.sessionDEK = null;
        this.keyExchangeComplete = false;
        this.busTransport._fireDisconnected();
      }
      return;
    }
    if (obj.type === 'pwa-bye' || obj.type === 'bye') {
      this.busTransport._fireDisconnected();
      return;
    }
    // Other signaling types (peer-connected, peer-offline) are no-ops here.
  }

  private async handleRoutedPayload(payload: string): Promise<void> {
    // Pre-ack window: the agent sends `key-exchange-ack` as plaintext JSON
    // inside the routed envelope. We track an explicit `keyExchangeComplete`
    // flag rather than inspecting `sessionDEK`, because we generate the DEK
    // before sending the key-exchange and would otherwise fall through to
    // the decrypt path with a payload that isn't ciphertext.
    if (!this.keyExchangeComplete) {
      try {
        const obj = JSON.parse(payload) as { type?: string; version?: number };
        if (obj.type === 'key-exchange-ack' && obj.version === 2) {
          this.keyExchangeComplete = true;
          // Idempotent: returns early if the bus transport is already
          // connected (e.g. on the very first ack `doStart` already awaits
          // the same event and calls this itself; no harm in firing twice).
          this.busTransport._fireConnected();
          this.events.emit('key-exchange-ack');
          return;
        }
      } catch {
        // Agent shouldn't send anything else before ack, but be permissive.
      }
      return;
    }
    if (!this.sessionDEK) return;

    let plaintext: string;
    try {
      plaintext = decryptWithSharedSecret(payload, this.sessionDEK);
    } catch (err) {
      console.error('FakePwa: decrypt failed', err);
      return;
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(plaintext, 'base64');
    } catch {
      return;
    }
    let decompressed: Buffer;
    try {
      decompressed = await gunzipAsync(buffer);
    } catch (err) {
      console.error('FakePwa: gunzip failed', err);
      return;
    }
    let message: Message;
    try {
      message = parseMessage(decompressed.toString('utf-8'));
    } catch {
      return;
    }
    if (message.type === 'bus:frame') {
      this.busTransport._receive(message.payload as ServerFrame);
      return;
    }
    // Other message types (handshake:ack, etc.) are not modeled in this
    // harness — the e2e tests focus on the bus layer.
  }

  private async startKeyExchange(): Promise<void> {
    // Generate session DEK + sign the V2 envelope exactly like the PWA does.
    const dek = generateSessionDEK();
    this.sessionDEK = dek;
    const encryptedDEK = encryptDEK(dek, this.agentPublicKey);
    const timestamp = Date.now();
    const { sigPubkey, signature } = signKeyExchangeV2({
      agentId: this.agentId,
      encryptedDEK,
      timestamp,
      signingPublicKey: this.signKeyPair.publicKey,
      signingSecretKey: this.signKeyPair.secretKey,
      encodeBase64,
    });
    const payload = JSON.stringify({
      type: 'key-exchange',
      version: 2,
      encryptedDEK,
      timestamp,
      sigPubkey,
      signature,
    });
    this.sendRouted(payload);
  }

  private sendRaw(obj: object): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(obj));
  }

  private sendRouted(payload: string): void {
    if (!this.socket) return;
    const envelope = {
      from: `pwa:${this.connectionId}`,
      to: `agent:${this.agentId}`,
      payload,
    };
    this.socket.send(JSON.stringify(envelope));
  }

  /**
   * Called by the bus transport: wraps a `ClientFrame` in a `bus:frame`
   * Message, gzips, encrypts with the session DEK, sends as a routed
   * envelope. Mirrors `AgentConnection.send()` in reverse.
   */
  private async sendBusFrame(frame: ClientFrame): Promise<void> {
    if (!this.sessionDEK) {
      throw new Error('FakePwa: bus frame sent before key exchange');
    }
    const wrapper = createMessage('bus:frame', frame as unknown);
    const serialized = serializeMessage(wrapper);
    const compressed = await gzipAsync(Buffer.from(serialized));
    const compressedBase64 = compressed.toString('base64');
    const encrypted = encryptWithSharedSecret(compressedBase64, this.sessionDEK);
    this.sendRouted(encrypted);
  }
}

// ---------------------------------------------------------------------------
// Bus transport adapter (PWA side)
// ---------------------------------------------------------------------------

class FakePwaBusTransport implements ClientTransport {
  private connected = false;
  private frameHandlers: Array<(frame: ServerFrame) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private outboundQueue: Promise<void> = Promise.resolve();

  /** `dispatch` runs the encrypt+send pipeline; rejection means crypto/IO error. */
  constructor(private dispatch: (frame: ClientFrame) => Promise<void>) {}

  isConnected(): boolean {
    return this.connected;
  }

  send(frame: ClientFrame): void {
    // Serialize outbound dispatch so multi-frame burst preserves order, the
    // way `AgentConnection.sendQueues` does on the agent side.
    this.outboundQueue = this.outboundQueue
      .then(() => this.dispatch(frame))
      .catch((err) => {
        console.error('FakePwaBusTransport: dispatch failed', err);
      });
  }

  onFrame(handler: (frame: ServerFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  onConnected(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  _receive(frame: ServerFrame): void {
    for (const h of this.frameHandlers) h(frame);
  }

  _fireConnected(): void {
    if (this.connected) return;
    this.connected = true;
    for (const h of this.connectHandlers) h();
  }

  _fireDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const h of this.disconnectHandlers) h();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fresh agent identity. Real crypto. */
export function makeAgentIdentity(): {
  agentId: string;
  keyPair: { publicKey: string; secretKey: string };
  signKeyPair: { publicKey: string; secretKey: string };
} {
  return {
    // Random id is fine; nothing else in tests cares about format.
    agentId: `agent-${Math.random().toString(36).slice(2, 10)}`,
    keyPair: encodeKeyPair(generateKeyPair()),
    signKeyPair: encodeKeyPair(generateSigningKeyPair()),
  };
}

function waitForOpen(socket: FakeWsSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === 1) {
      // Already open — flush a microtask so listeners attach first.
      queueMicrotask(() => resolve());
      return;
    }
    socket.once('open', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// StubProvider — drives `claude:start` / `claude:resume` flows without
// spawning a real CLI. Tests retain a handle on the provider and call
// `emitCard()` / `finishStream()` to push events through the SessionManager
// callbacks; SessionManager re-emits them as `card-event` / `card-stream-end`,
// which `wireSessionBus` translates into `/sessions/:id/cards` updates on
// the bus.
// ---------------------------------------------------------------------------

export interface StubProviderOpts {
  /** Provider id surfaced to SessionManager. Defaults to `'claude-code'`. */
  id?: AgentId;
  /** Defaults to `'memory'` so `getCards()` stays in-process and doesn't
   *  read JSONL from disk. */
  historyMode?: ProviderHistoryMode;
  /** Override sessionId generation. Default = `stub-{nanos}-{counter}`. */
  generateSessionId?: () => string;
}

interface StubSession {
  sessionId: string;
  cwd: string;
  streamId: string;
  cardBuilder: StreamCardBuilder;
  callbacks: ProviderCallbacks;
  alive: boolean;
  receivedPrompts: string[];
  interrupted: boolean;
  killed: boolean;
}

export class StubProvider implements CodingAgentProvider {
  readonly id: AgentId;
  readonly historyMode: ProviderHistoryMode;
  private generateSessionId: () => string;
  private counter = 0;
  private sessions = new Map<string, StubSession>();

  constructor(opts: StubProviderOpts = {}) {
    this.id = opts.id ?? 'claude-code';
    this.historyMode = opts.historyMode ?? 'memory';
    this.generateSessionId =
      opts.generateSessionId ??
      (() => `stub-${Date.now()}-${++this.counter}`);
  }

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const sessionId = this.generateSessionId();
    const session = this.makeSession(sessionId, opts.cwd, opts.streamId, cardBuilder, callbacks);
    session.receivedPrompts.push(opts.prompt);
    return { sessionId, session: this.toProviderSession(session) };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const session = this.makeSession(opts.sessionId, opts.cwd, opts.streamId, cardBuilder, callbacks);
    session.receivedPrompts.push(opts.prompt);
    return { sessionId: opts.sessionId, session: this.toProviderSession(session) };
  }

  // ── Test API ────────────────────────────────────────────────────────────

  /** Push a `card-event` for a given session. Throws if the session is not active. */
  emitCard(sessionId: string, event: CardEvent): void {
    const s = this.requireSession(sessionId);
    s.callbacks.emitCardEvent(event);
  }

  /** Fire `card-stream-end` and mark the session inactive (mirrors the
   *  provider exiting). */
  finishStream(sessionId: string, result: Omit<CardStreamEnd, 'streamId' | 'sessionId'>): void {
    const s = this.requireSession(sessionId);
    s.alive = false;
    const full: CardStreamEnd = {
      streamId: s.streamId,
      sessionId,
      ...result,
    };
    s.callbacks.emitStreamEnd(full);
    s.callbacks.onSessionExited?.(sessionId, this.toProviderSession(s));
  }

  /** Inspect what `sendUserMessage` calls the provider has received. */
  promptsFor(sessionId: string): string[] {
    return [...this.requireSession(sessionId).receivedPrompts];
  }

  /** Whether `interrupt()` was called. */
  wasInterrupted(sessionId: string): boolean {
    return this.requireSession(sessionId).interrupted;
  }

  /** Whether `kill()` was called. */
  wasKilled(sessionId: string): boolean {
    return this.requireSession(sessionId).killed;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private makeSession(
    sessionId: string,
    cwd: string,
    streamId: string,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): StubSession {
    const session: StubSession = {
      sessionId,
      cwd,
      streamId,
      cardBuilder,
      callbacks,
      alive: true,
      receivedPrompts: [],
      interrupted: false,
      killed: false,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private toProviderSession(s: StubSession): ProviderSession {
    return {
      get alive() {
        return s.alive;
      },
      sendUserMessage(prompt: string): void {
        s.receivedPrompts.push(prompt);
      },
      interrupt(): void {
        s.interrupted = true;
      },
      kill(): void {
        s.killed = true;
        s.alive = false;
      },
    };
  }

  private requireSession(sessionId: string): StubSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`StubProvider: no session ${sessionId}`);
    return s;
  }
}

// ---------------------------------------------------------------------------
// wireSessionBus — minimal subset of `service/run.ts`'s session-bus wiring
// for tests. Registers `/sessions/active`, `/sessions/:sessionId/cards`,
// `/preferences`, `/sessions/config` subscriptions and forwards SessionManager
// events onto the bus. No push-notify, no event-store, no session registry
// side effects — the harness focuses on the bus surface.
// ---------------------------------------------------------------------------

export function wireSessionBus(
  bus: MessageBusServer,
  sessionManager: SessionManager,
): void {
  bus.onSubscribe<'/sessions/active', SessionUpdatePayload[], SessionUpdatePayload>(
    '/sessions/active',
    { snapshot: () => sessionManager.snapshotActiveSessions() },
  );

  bus.onSubscribe<'/sessions/:sessionId/cards', CardHistoryResponse, SessionCardsUpdate>(
    '/sessions/:sessionId/cards',
    {
      snapshot: async ({ params }) => {
        const sessionId = params.sessionId;
        const cwd = sessionManager.getSessionCwd(sessionId) ?? '';
        return sessionManager.getCards(sessionId, cwd, 0, 50);
      },
    },
  );

  bus.onSubscribe<'/preferences', ClaudePreferences, ClaudePreferences>(
    '/preferences',
    { snapshot: () => sessionManager.getPreferences() },
  );

  bus.onSubscribe<
    '/sessions/config',
    Record<string, Record<string, ConfigValue>>,
    SessionConfigUpdatedPayload
  >(
    '/sessions/config',
    { snapshot: () => sessionManager.getAllSessionConfigs() },
  );

  sessionManager.on('card-event', (event: CardEvent) => {
    bus.publish<SessionCardsUpdate>(
      `/sessions/${event.sessionId}/cards`,
      { kind: 'card', event },
    );
  });
  sessionManager.on('card-stream-end', (result: CardStreamEnd) => {
    bus.publish<SessionCardsUpdate>(
      `/sessions/${result.sessionId}/cards`,
      { kind: 'stream-end', result },
    );
  });
  sessionManager.on('session-updated', (payload: SessionUpdatePayload) => {
    bus.publish<SessionUpdatePayload>('/sessions/active', payload);
  });
  sessionManager.on('preferences-updated', (prefs: ClaudePreferences) => {
    bus.publish<ClaudePreferences>('/preferences', prefs);
  });
  sessionManager.on('session-config-updated', (payload: SessionConfigUpdatedPayload) => {
    bus.publish<SessionConfigUpdatedPayload>('/sessions/config', payload);
  });
}
