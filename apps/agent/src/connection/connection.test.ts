// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { BROADCAST_TOPIC } from './pubsub.js';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they are available inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  MockSignalingClient,
  mockDecodeKeyPair,
  mockDecryptDEK,
  mockEncryptWithSharedSecret,
  mockDecryptWithSharedSecret,
  mockParseMessage,
  mockSerializeMessage,
  mockVerifyKeyExchangeV2Signature,
  mockDecodeBase64,
  mockIsPaired,
  mockLoadConfig,
  mockPinPeerPWA,
  mockClearPeerPWA,
  mockUnlockPairingAndRotate,
  mockCheckTombstone,
} = vi.hoisted(() => {
  const { EventEmitter } = require('events');

  class MockSignalingClient extends EventEmitter {
    connectCalled = false;
    sentMessages: Array<{ data: string; target: string | null }> = [];
    // Tombstone push subscription tracking so tests can assert connection-level
    // calls into the signaling layer.
    subscribedKeys: string[] = [];
    unsubscribedKeys: string[] = [];

    constructor(_url: string, _agentId: string) {
      super();
    }

    async connect(): Promise<void> {
      this.connectCalled = true;
    }

    sendData(data: string, targetAddress: string | null): void {
      this.sentMessages.push({ data, target: targetAddress });
    }

    subscribeTombstone(keyHash: string): void {
      this.subscribedKeys.push(keyHash);
    }

    unsubscribeTombstone(keyHash: string): void {
      this.unsubscribedKeys.push(keyHash);
    }

    disconnect(): void {}
  }

  return {
    MockSignalingClient,
    mockDecodeKeyPair: vi.fn().mockReturnValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    mockDecryptDEK: vi.fn().mockReturnValue(new Uint8Array(32)),
    mockEncryptWithSharedSecret: vi.fn().mockReturnValue('encrypted-payload'),
    mockDecryptWithSharedSecret: vi.fn().mockReturnValue(''),
    mockParseMessage: vi.fn(),
    mockSerializeMessage: vi.fn().mockReturnValue('{"type":"ping"}'),
    // Default: signature verify succeeds. Individual tests override.
    mockVerifyKeyExchangeV2Signature: vi.fn().mockReturnValue(true),
    mockDecodeBase64: vi.fn().mockReturnValue(new Uint8Array(32)),
    // Default: agent is unpaired so TOFU path is taken. Tests override.
    mockIsPaired: vi.fn().mockReturnValue(false),
    mockLoadConfig: vi.fn().mockReturnValue({
      agentId: 'agent-test-001',
      keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
      signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      signalingServer: 'wss://test.example.com',
    }),
    mockPinPeerPWA: vi.fn(),
    mockClearPeerPWA: vi.fn(),
    mockUnlockPairingAndRotate: vi.fn().mockReturnValue({
      agentId: 'agent-rotated-001',
      keyPair: { publicKey: 'rotated-pub', secretKey: 'rotated-sec' },
      signKeyPair: { publicKey: 'rotated-sign-pub', secretKey: 'rotated-sign-sec' },
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      closed: false,
      signalingServer: 'wss://test.example.com',
    }),
    // Default: no tombstone — tests override per case.
    mockCheckTombstone: vi.fn().mockResolvedValue({ status: 'absent' }),
  };
});

vi.mock('./relay.js', () => ({
  SignalingClient: MockSignalingClient,
}));

vi.mock('../config.js', () => ({
  isPaired: mockIsPaired,
  loadConfig: mockLoadConfig,
  pinPeerPWA: mockPinPeerPWA,
  clearPeerPWA: mockClearPeerPWA,
  unlockPairingAndRotate: mockUnlockPairingAndRotate,
}));

// Minimal mocks for the helpers the production code now imports from
// tombstoneCheck. Real logic is exercised in tombstoneCheck.test.ts — here we
// just need the symbols to resolve. Using vi.hoisted so the variables are
// initialised before vi.mock's hoisted factory runs.
const { mockHashPublicKey, mockVerifyTombstonePayload } = vi.hoisted(() => ({
  mockHashPublicKey: vi.fn((pk: string) => `hash-${pk.slice(0, 8)}`),
  mockVerifyTombstonePayload: vi.fn(),
}));
vi.mock('../tombstoneCheck.js', () => ({
  checkTombstone: mockCheckTombstone,
  hashPublicKey: mockHashPublicKey,
  verifyTombstonePayload: mockVerifyTombstonePayload,
}));

vi.mock('@sumicom/quicksave-shared', () => ({
  generateKeyPair: vi.fn(),
  encodeKeyPair: vi.fn(),
  decodeKeyPair: mockDecodeKeyPair,
  decodeBase64: mockDecodeBase64,
  encryptWithSharedSecret: mockEncryptWithSharedSecret,
  decryptWithSharedSecret: mockDecryptWithSharedSecret,
  decryptDEK: mockDecryptDEK,
  parseMessage: mockParseMessage,
  serializeMessage: mockSerializeMessage,
  verifyKeyExchangeV2Signature: mockVerifyKeyExchangeV2Signature,
}));

// Mock zlib — avoid real compression in unit tests
vi.mock('zlib', () => ({
  gzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('compressed'))),
  gunzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('decompressed'))),
}));

import { AgentConnection, type ConnectionConfig } from './connection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): ConnectionConfig {
  return {
    signalingServer: 'wss://test.example.com',
    agentId: 'agent-test-001',
    keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
  };
}

function makeMessage(type = 'ping', payload: unknown = {}): {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
} {
  return { id: 'msg-1', type, payload, timestamp: Date.now() };
}

/** Access the private signaling field for emitting test events. */
function getSignaling(conn: AgentConnection): MockSignalingClient {
  return (conn as any).signaling as MockSignalingClient;
}

/** Simulate a successful key exchange so the peer is registered. */
function addPeer(
  conn: AgentConnection,
  address: string,
  opts: { sigPubkey?: string; signature?: string } = {},
): void {
  const sig = getSignaling(conn);
  const keyExchange = JSON.stringify({
    type: 'key-exchange',
    version: 2,
    encryptedDEK: 'encrypted-dek-base64',
    timestamp: Date.now(),
    sigPubkey: opts.sigPubkey ?? 'peer-sign-pubkey-base64',
    signature: opts.signature ?? 'signature-base64',
  });
  sig.emit('data', keyExchange, address);
}

/** Wait for microtasks / next tick to let async handlers settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentConnection', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  // -----------------------------------------------------------------------
  // Basic accessors
  // -----------------------------------------------------------------------

  describe('accessors', () => {
    it('getPublicKey returns configured public key', () => {
      expect(conn.getPublicKey()).toBe('pub-key-base64');
    });

    it('getAgentId returns configured agent id', () => {
      expect(conn.getAgentId()).toBe('agent-test-001');
    });

    it('hasPeers returns false initially', () => {
      expect(conn.hasPeers()).toBe(false);
    });

    it('getPeerCount returns 0 initially', () => {
      expect(conn.getPeerCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // start()
  // -----------------------------------------------------------------------

  describe('start()', () => {
    it('calls signaling.connect()', async () => {
      const sig = getSignaling(conn);
      await conn.start();
      expect(sig.connectCalled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Key exchange / peer lifecycle
  // -----------------------------------------------------------------------

  describe('key exchange', () => {
    it('registers a peer after successful key exchange', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      expect(conn.hasPeers()).toBe(true);
      expect(conn.getPeerCount()).toBe(1);
    });

    it('emits "connected" after key exchange', async () => {
      const handler = vi.fn();
      conn.on('connected', handler);

      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      expect(handler).toHaveBeenCalledWith('pwa:peer-aaa');
    });

    it('sends key-exchange-ack after key exchange', async () => {
      const sig = getSignaling(conn);
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      const ack = sig.sentMessages.find(
        (m) => m.target === 'pwa:peer-aaa' && m.data.includes('key-exchange-ack'),
      );
      expect(ack).toBeDefined();
    });

    it('auto-subscribes new peer to broadcast topic', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      const state = conn.getDebugState();
      expect(state.subscriptions[BROADCAST_TOPIC]).toBeDefined();
      expect(state.subscriptions[BROADCAST_TOPIC]).toContain('pwa:peer-aaa'.slice(0, 16));
    });

    it('rejects expired key exchange', async () => {
      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      const sig = getSignaling(conn);
      const keyExchange = JSON.stringify({
        type: 'key-exchange',
        version: 2,
        encryptedDEK: 'encrypted-dek-base64',
        timestamp: Date.now() - 120000, // 2 minutes ago
      });
      sig.emit('data', keyExchange, 'pwa:peer-old');
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('rejects key exchange with future timestamp', async () => {
      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      const sig = getSignaling(conn);
      const keyExchange = JSON.stringify({
        type: 'key-exchange',
        version: 2,
        encryptedDEK: 'encrypted-dek-base64',
        timestamp: Date.now() + 30000, // 30 seconds in future (> 5s skew)
      });
      sig.emit('data', keyExchange, 'pwa:peer-future');
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('handles peer reconnect with new DEK', async () => {
      const disconnectedHandler = vi.fn();
      const connectedHandler = vi.fn();
      conn.on('disconnected', disconnectedHandler);
      conn.on('connected', connectedHandler);

      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      // Re-key exchange (same address, simulates PWA refresh)
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      // Should emit disconnected for old session, then connected for new
      expect(disconnectedHandler).toHaveBeenCalledWith('pwa:peer-aaa');
      expect(connectedHandler).toHaveBeenCalledTimes(2);
      expect(conn.getPeerCount()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // broadcast
  // -----------------------------------------------------------------------

  describe('broadcast', () => {
    it('sends to all peers on broadcast topic', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      addPeer(conn, 'pwa:peer-bbb');
      await flush();

      const sig = getSignaling(conn);
      sig.sentMessages = [];

      conn.broadcast(makeMessage());
      await flush();

      const targets = sig.sentMessages.map((m) => m.target);
      expect(targets).toContain('pwa:peer-aaa');
      expect(targets).toContain('pwa:peer-bbb');
    });

    it('falls back to all peers if broadcast topic is empty', () => {
      // Manually insert peers without going through key exchange
      // (bypasses auto-subscribe to broadcast)
      const peers = (conn as any).peers as Map<string, any>;
      peers.set('pwa:manual-1', {
        address: 'pwa:manual-1',
        sessionDEK: new Uint8Array(32),
        connectedAt: Date.now(),
      });
      peers.set('pwa:manual-2', {
        address: 'pwa:manual-2',
        sessionDEK: new Uint8Array(32),
        connectedAt: Date.now(),
      });

      const sig = getSignaling(conn);
      sig.sentMessages = [];

      conn.broadcast(makeMessage());

      // send() is called for each peer (async, so we just check the queues were created)
      const queues = (conn as any).sendQueues as Map<string, Promise<void>>;
      expect(queues.size).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // send() queue ordering
  // -----------------------------------------------------------------------

  describe('send() queue', () => {
    it('queues messages per-peer for ordering', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      const sig = getSignaling(conn);
      sig.sentMessages = [];

      // Send multiple messages quickly
      conn.send(makeMessage('ping', { seq: 1 }), 'pwa:peer-aaa');
      conn.send(makeMessage('ping', { seq: 2 }), 'pwa:peer-aaa');
      conn.send(makeMessage('ping', { seq: 3 }), 'pwa:peer-aaa');

      // Wait for all queued sends to complete
      await flush();
      await flush();

      // All three messages should be sent to peer-aaa (encrypted)
      const peerMessages = sig.sentMessages.filter((m) => m.target === 'pwa:peer-aaa');
      expect(peerMessages.length).toBe(3);
    });

    it('silently skips send if peer not found', () => {
      // No peers registered
      expect(() => {
        conn.send(makeMessage(), 'pwa:nonexistent');
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Peer disconnect (pwa-bye)
  // -----------------------------------------------------------------------

  describe('handlePeerDisconnected (pwa-bye)', () => {
    it('removes peer and clears subscriptions', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      const sig = getSignaling(conn);
      sig.emit('pwa-bye', 'pwa:peer-aaa');

      expect(conn.hasPeers()).toBe(false);
      expect(conn.getPeerCount()).toBe(0);

      const state = conn.getDebugState();
      expect(state.peers).toHaveLength(0);
      expect(state.subscriptions[BROADCAST_TOPIC] ?? []).not.toContain('pwa:peer-aaa');
    });

    it('emits "disconnected" event', async () => {
      const handler = vi.fn();
      conn.on('disconnected', handler);

      addPeer(conn, 'pwa:peer-aaa');
      await flush();
      handler.mockClear();

      const sig = getSignaling(conn);
      sig.emit('pwa-bye', 'pwa:peer-aaa');

      expect(handler).toHaveBeenCalledWith('pwa:peer-aaa');
    });

    it('is a no-op for unknown peer', async () => {
      const handler = vi.fn();
      conn.on('disconnected', handler);

      const sig = getSignaling(conn);
      sig.emit('pwa-bye', 'pwa:unknown');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Legacy peer-disconnected (clears all peers)
  // -----------------------------------------------------------------------

  describe('peer-disconnected (legacy)', () => {
    it('clears all peers on legacy peer-disconnected', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      addPeer(conn, 'pwa:peer-bbb');
      await flush();

      const sig = getSignaling(conn);
      sig.emit('peer-disconnected');

      expect(conn.hasPeers()).toBe(false);
      expect(conn.getPeerCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Signaling disconnect (WebSocket reconnect)
  // -----------------------------------------------------------------------

  describe('signaling disconnected', () => {
    it('clears ALL peers and subscriptions', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      addPeer(conn, 'pwa:peer-bbb');
      await flush();

      const sig = getSignaling(conn);
      sig.emit('disconnected');

      expect(conn.hasPeers()).toBe(false);
      expect(conn.getPeerCount()).toBe(0);
    });

    it('emits "disconnected" for each peer', async () => {
      const handler = vi.fn();
      conn.on('disconnected', handler);

      addPeer(conn, 'pwa:peer-aaa');
      addPeer(conn, 'pwa:peer-bbb');
      await flush();
      handler.mockClear();

      const sig = getSignaling(conn);
      sig.emit('disconnected');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith('pwa:peer-aaa');
      expect(handler).toHaveBeenCalledWith('pwa:peer-bbb');
    });
  });

  // -----------------------------------------------------------------------
  // getDebugState
  // -----------------------------------------------------------------------

  describe('getDebugState', () => {
    it('returns empty state when no peers', () => {
      const state = conn.getDebugState();
      expect(state.peers).toEqual([]);
      expect(state.subscriptions).toEqual({});
    });

    it('returns snapshot of peers and subscriptions', async () => {
      addPeer(conn, 'pwa:peer-aaa');
      await flush();

      const state = conn.getDebugState();
      expect(state.peers).toHaveLength(1);
      expect(state.peers[0].address).toBe('pwa:peer-aaa'.slice(0, 16));
      expect(state.peers[0].topics).toContain(BROADCAST_TOPIC);

      expect(state.subscriptions[BROADCAST_TOPIC]).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error forwarding
  // -----------------------------------------------------------------------

  describe('error forwarding', () => {
    it('forwards signaling errors', () => {
      const handler = vi.fn();
      conn.on('error', handler);

      const sig = getSignaling(conn);
      sig.emit('error', new Error('ws failed'));

      expect(handler).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // TOFU peer PWA pinning (C2)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Tombstone self-destruct
  // -----------------------------------------------------------------------

  describe('tombstone self-destruct', () => {
    const PAIRED_CONFIG = {
      agentId: 'agent-test-001',
      keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
      signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
      peerPWAPublicKey: 'pinned-peer-pub',
      peerPWASignPublicKey: 'pinned-peer-sign-pub',
      signalingServer: 'wss://test.example.com',
    };

    it('returns null and does not call checkTombstone when unpaired', async () => {
      mockIsPaired.mockReturnValue(false);

      const result = await conn.runTombstoneCheck();

      expect(result).toBeNull();
      expect(mockCheckTombstone).not.toHaveBeenCalled();
      expect(mockClearPeerPWA).not.toHaveBeenCalled();
    });

    it('returns null when loadConfig() returns null', async () => {
      mockLoadConfig.mockReturnValueOnce(null);

      const result = await conn.runTombstoneCheck();

      expect(result).toBeNull();
      expect(mockCheckTombstone).not.toHaveBeenCalled();
    });

    it('returns "absent" and does not self-destruct on paired-but-no-tombstone', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValueOnce({ status: 'absent' });

      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const result = await conn.runTombstoneCheck();

      expect(result).toEqual({ status: 'absent' });
      expect(mockCheckTombstone).toHaveBeenCalledWith({
        signalingServer: 'wss://test.example.com',
        peerPWAPublicKey: 'pinned-peer-pub',
        peerPWASignPublicKey: 'pinned-peer-sign-pub',
      });
      expect(tombstonedHandler).not.toHaveBeenCalled();
      expect(mockClearPeerPWA).not.toHaveBeenCalled();
    });

    it('self-destructs on a "tombstoned" result: emits tombstoned, clears peer PWA, evicts active peers', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);

      // Register two live peers first (before we arm the tombstone response).
      // Use matching sigPubkey since the test config is paired.
      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'pinned-peer-sign-pub' });
      addPeer(conn, 'pwa:peer-bbb', { sigPubkey: 'pinned-peer-sign-pub' });
      await flush();
      expect(conn.getPeerCount()).toBe(2);

      const tombstone = {
        type: 'rotated' as const,
        oldPublicKey: 'pinned-peer-pub',
        signature: 'sig-base64',
      };
      mockCheckTombstone.mockResolvedValueOnce({
        status: 'tombstoned',
        tombstone,
      });

      const tombstonedHandler = vi.fn();
      const disconnectedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);
      conn.on('disconnected', disconnectedHandler);

      const result = await conn.runTombstoneCheck();

      expect(result?.status).toBe('tombstoned');

      // tombstoned event carries the oldPublicKey from the tombstone
      expect(tombstonedHandler).toHaveBeenCalledTimes(1);
      expect(tombstonedHandler).toHaveBeenCalledWith({
        oldPublicKey: 'pinned-peer-pub',
      });

      // config-side self-destruct
      expect(mockClearPeerPWA).toHaveBeenCalledTimes(1);

      // All active peers evicted with a disconnected emit each
      expect(conn.hasPeers()).toBe(false);
      expect(conn.getPeerCount()).toBe(0);
      expect(disconnectedHandler).toHaveBeenCalledWith('pwa:peer-aaa');
      expect(disconnectedHandler).toHaveBeenCalledWith('pwa:peer-bbb');
    });

    it('does NOT self-destruct on "verify-failed" (bad tombstone is ignored)', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValueOnce({
        status: 'verify-failed',
        reason: 'signature verify failed',
      });

      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'pinned-peer-sign-pub' });
      await flush();

      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const result = await conn.runTombstoneCheck();

      expect(result?.status).toBe('verify-failed');
      expect(tombstonedHandler).not.toHaveBeenCalled();
      expect(mockClearPeerPWA).not.toHaveBeenCalled();
      // Live peer still there
      expect(conn.hasPeers()).toBe(true);
    });

    it('does NOT self-destruct on "error" (transient network failure)', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValueOnce({
        status: 'error',
        error: 'ECONNREFUSED',
      });

      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'pinned-peer-sign-pub' });
      await flush();

      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const result = await conn.runTombstoneCheck();

      expect(result?.status).toBe('error');
      expect(tombstonedHandler).not.toHaveBeenCalled();
      expect(mockClearPeerPWA).not.toHaveBeenCalled();
      expect(conn.hasPeers()).toBe(true);
    });

    it('runs the tombstone check when signaling emits "connected"', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValueOnce({ status: 'absent' });

      const sig = getSignaling(conn);
      sig.emit('connected');

      // Let the microtask chain from the async handler settle.
      await flush();
      await flush();

      expect(mockCheckTombstone).toHaveBeenCalledTimes(1);
      expect(mockCheckTombstone).toHaveBeenCalledWith({
        signalingServer: 'wss://test.example.com',
        peerPWAPublicKey: 'pinned-peer-pub',
        peerPWASignPublicKey: 'pinned-peer-sign-pub',
      });
    });
  });

  describe('TOFU peer PWA pinning', () => {
    it('pins peer PWA sigPubkey on first successful exchange (unpaired → paired)', async () => {
      // Use mockReturnValue (not Once) so every getState()/isPaired() call
      // during the flow sees unpaired — the test describe above may have left
      // mockIsPaired returning true, and vi.clearAllMocks only clears history.
      mockIsPaired.mockReturnValue(false);

      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'first-sig-pubkey' });
      await flush();

      expect(conn.hasPeers()).toBe(true);
      expect(mockPinPeerPWA).toHaveBeenCalledWith('peer-aaa', 'first-sig-pubkey');
    });

    it('rejects key exchange when sigPubkey does not match pinned value', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-test-001',
        keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
        signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
        peerPWAPublicKey: 'peer-aaa',
        peerPWASignPublicKey: 'pinned-sig-pubkey',
        signalingServer: 'wss://test.example.com',
      });

      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'different-sig-pubkey' });
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
      expect(mockPinPeerPWA).not.toHaveBeenCalled();
    });

    it('accepts key exchange when sigPubkey matches pinned value', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-test-001',
        keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
        signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
        peerPWAPublicKey: 'peer-aaa',
        peerPWASignPublicKey: 'pinned-sig-pubkey',
        signalingServer: 'wss://test.example.com',
      });

      addPeer(conn, 'pwa:peer-aaa', { sigPubkey: 'pinned-sig-pubkey' });
      await flush();

      expect(conn.hasPeers()).toBe(true);
      // Already paired → should NOT call pinPeerPWA
      expect(mockPinPeerPWA).not.toHaveBeenCalled();
    });

    it('rejects key exchange missing sigPubkey field', async () => {
      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      const sig = getSignaling(conn);
      const keyExchange = JSON.stringify({
        type: 'key-exchange',
        version: 2,
        encryptedDEK: 'encrypted-dek-base64',
        timestamp: Date.now(),
        signature: 'signature-base64',
        // no sigPubkey
      });
      sig.emit('data', keyExchange, 'pwa:peer-nosig');
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('rejects key exchange missing signature field', async () => {
      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      const sig = getSignaling(conn);
      const keyExchange = JSON.stringify({
        type: 'key-exchange',
        version: 2,
        encryptedDEK: 'encrypted-dek-base64',
        timestamp: Date.now(),
        sigPubkey: 'peer-sign-pubkey-base64',
        // no signature
      });
      sig.emit('data', keyExchange, 'pwa:peer-nosig');
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('rejects key exchange when signature verification fails', async () => {
      mockVerifyKeyExchangeV2Signature.mockReturnValueOnce(false);

      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      addPeer(conn, 'pwa:peer-badsig');
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
      expect(mockPinPeerPWA).not.toHaveBeenCalled();
    });
  });

  describe('pair state (closed / paired / unpaired)', () => {
    const PAIRED_CONFIG = {
      agentId: 'agent-test-001',
      keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
      signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
      peerPWAPublicKey: 'pinned-peer-pub',
      peerPWASignPublicKey: 'pinned-peer-sign-pub',
      closed: false,
      signalingServer: 'wss://test.example.com',
    };

    const CLOSED_CONFIG = {
      agentId: 'agent-rotated-001',
      keyPair: { publicKey: 'rotated-pub', secretKey: 'rotated-sec' },
      signKeyPair: { publicKey: 'rotated-sign-pub', secretKey: 'rotated-sign-sec' },
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      closed: true,
      signalingServer: 'wss://test.example.com',
    };

    const UNPAIRED_CONFIG = {
      ...CLOSED_CONFIG,
      closed: false,
    };

    const TOMBSTONE_RESULT = {
      status: 'tombstoned' as const,
      tombstone: {
        type: 'rotated' as const,
        oldPublicKey: 'pinned-peer-pub',
        signature: 'sig-base64',
      },
    };

    it('getState returns "unpaired" when config has no peerPWA* and closed is false', () => {
      mockIsPaired.mockReturnValue(false);
      mockLoadConfig.mockReturnValue(UNPAIRED_CONFIG);
      expect(conn.getState()).toBe('unpaired');
    });

    it('getState returns "paired" when config has peerPWA* pinned', () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      expect(conn.getState()).toBe('paired');
    });

    it('getState returns "closed" when config.closed is true (persisted across restart)', () => {
      mockLoadConfig.mockReturnValue(CLOSED_CONFIG);
      // closed beats isPaired even if isPaired somehow returns true
      mockIsPaired.mockReturnValue(true);
      expect(conn.getState()).toBe('closed');
    });

    it('getState returns "closed" after a verified tombstone (clearPeerPWA persists closed=true)', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValueOnce(TOMBSTONE_RESULT);
      // Model clearPeerPWA side effect: after tombstone, loadConfig returns
      // CLOSED_CONFIG (rotated + closed=true).
      mockClearPeerPWA.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue(CLOSED_CONFIG);
        return CLOSED_CONFIG;
      });
      conn.on('tombstoned', () => {});

      await conn.runTombstoneCheck();

      expect(mockClearPeerPWA).toHaveBeenCalledTimes(1);
      expect(conn.getState()).toBe('closed');
    });

    it('unlockPairing rotates keys and drops state from closed back to unpaired', async () => {
      // Start closed (post-tombstone state).
      mockLoadConfig.mockReturnValue(CLOSED_CONFIG);
      expect(conn.getState()).toBe('closed');

      // unlockPairingAndRotate side effect: fresh UNPAIRED_CONFIG. Reset
      // mockIsPaired to false so the subsequent getState() sees an unpaired
      // config (UNPAIRED_CONFIG has peerPWAPublicKey=null).
      mockUnlockPairingAndRotate.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue(UNPAIRED_CONFIG);
        mockIsPaired.mockReturnValue(false);
        return UNPAIRED_CONFIG;
      });

      const result = await conn.unlockPairing();

      expect(mockUnlockPairingAndRotate).toHaveBeenCalledTimes(1);
      expect(result.agentId).toBe('agent-rotated-001');
      expect(conn.getState()).toBe('unpaired');
    });

    it('unlockPairing emits identity-rotated with the new agentId', async () => {
      mockLoadConfig.mockReturnValue(CLOSED_CONFIG);
      mockUnlockPairingAndRotate.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue(UNPAIRED_CONFIG);
        mockIsPaired.mockReturnValue(false);
        return UNPAIRED_CONFIG;
      });
      const rotatedHandler = vi.fn();
      conn.on('identity-rotated', rotatedHandler);

      await conn.unlockPairing();

      expect(rotatedHandler).toHaveBeenCalledWith({ agentId: 'agent-rotated-001' });
    });

    it('handleKeyExchange refuses new peers while in closed state', async () => {
      mockLoadConfig.mockReturnValue(CLOSED_CONFIG);

      const errorHandler = vi.fn();
      conn.on('error', errorHandler);

      addPeer(conn, 'pwa:peer-new', { sigPubkey: 'fresh-sig-pk' });
      await flush();

      expect(conn.hasPeers()).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
      // Pin MUST NOT happen while closed — confirms the gate is before TOFU.
      expect(mockPinPeerPWA).not.toHaveBeenCalled();
    });

    it('after unlockPairing, handleKeyExchange proceeds again and can TOFU-pin', async () => {
      mockLoadConfig.mockReturnValue(CLOSED_CONFIG);
      mockUnlockPairingAndRotate.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue(UNPAIRED_CONFIG);
        mockIsPaired.mockReturnValue(false);
        return UNPAIRED_CONFIG;
      });

      await conn.unlockPairing();
      expect(conn.getState()).toBe('unpaired');

      addPeer(conn, 'pwa:peer-fresh', { sigPubkey: 'fresh-sig-pk' });
      await flush();

      expect(conn.hasPeers()).toBe(true);
      expect(mockPinPeerPWA).toHaveBeenCalledWith('peer-fresh', 'fresh-sig-pk');
    });

    it('unlockPairing is callable from any state (always rotates)', async () => {
      // Start paired — a user re-pairing deliberately, not a tombstone path.
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockIsPaired.mockReturnValue(true);
      expect(conn.getState()).toBe('paired');

      mockUnlockPairingAndRotate.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue(UNPAIRED_CONFIG);
        mockIsPaired.mockReturnValue(false);
        mockIsPaired.mockReturnValue(false);
        return UNPAIRED_CONFIG;
      });

      await conn.unlockPairing();

      expect(mockUnlockPairingAndRotate).toHaveBeenCalledTimes(1);
      expect(conn.getState()).toBe('unpaired');
    });
  });

  // -----------------------------------------------------------------------
  // Tombstone push (relay pubsub) — subscribe-on-connect, event handling,
  // idempotency with the catch-up GET path.
  // -----------------------------------------------------------------------

  describe('tombstone push channel', () => {
    const PAIRED_CONFIG = {
      agentId: 'agent-test-001',
      keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
      signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
      peerPWAPublicKey: 'pinned-peer-pub',
      peerPWASignPublicKey: 'pinned-peer-sign-pub',
      signalingServer: 'wss://test.example.com',
    };

    it('subscribes to the pinned peer mailbox when signaling connects while paired', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValue({ status: 'absent' });

      const sig = getSignaling(conn);
      sig.emit('connected');
      await flush();
      await flush();

      expect(mockHashPublicKey).toHaveBeenCalledWith('pinned-peer-pub');
      // hashPublicKey is mocked to `hash-<first8>`
      expect(sig.subscribedKeys).toEqual(['hash-pinned-p']);
    });

    it('does NOT subscribe when unpaired (no pinned peer to watch yet)', async () => {
      mockIsPaired.mockReturnValue(false);
      mockLoadConfig.mockReturnValue({ ...PAIRED_CONFIG, peerPWAPublicKey: null });

      const sig = getSignaling(conn);
      sig.emit('connected');
      await flush();

      expect(sig.subscribedKeys).toEqual([]);
    });

    it('subscribe is idempotent across reconnects for the same pinned peer', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockCheckTombstone.mockResolvedValue({ status: 'absent' });

      const sig = getSignaling(conn);
      sig.emit('connected');
      await flush();
      sig.emit('connected');
      await flush();
      sig.emit('connected');
      await flush();

      // Only the first call issues an explicit subscribe; subsequent connects
      // are handled by SignalingClient's own replay list (not tested here).
      expect(sig.subscribedKeys).toEqual(['hash-pinned-p']);
    });

    it('verifies a pushed tombstone and self-destructs on success', async () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockVerifyTombstonePayload.mockReturnValue({
        status: 'tombstoned',
        tombstone: {
          type: 'rotated',
          oldPublicKey: 'pinned-peer-pub',
          signature: 'sig',
        },
      });
      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const sig = getSignaling(conn);
      sig.emit('tombstone-event', 'hash-pinned-p', 'raw-tombstone-json');

      expect(mockVerifyTombstonePayload).toHaveBeenCalledWith(
        'raw-tombstone-json',
        'pinned-peer-pub',
        'pinned-peer-sign-pub',
      );
      expect(mockClearPeerPWA).toHaveBeenCalledTimes(1);
      expect(tombstonedHandler).toHaveBeenCalledWith({
        oldPublicKey: 'pinned-peer-pub',
      });
    });

    it('ignores a pushed tombstone for a non-matching keyHash', () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const sig = getSignaling(conn);
      sig.emit('tombstone-event', 'hash-other-mailbox', 'anything');

      expect(mockVerifyTombstonePayload).not.toHaveBeenCalled();
      expect(mockClearPeerPWA).not.toHaveBeenCalled();
      expect(tombstonedHandler).not.toHaveBeenCalled();
    });

    it('ignores a pushed payload whose verification fails', () => {
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockVerifyTombstonePayload.mockReturnValue({
        status: 'verify-failed',
        reason: 'signature verify failed',
      });
      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const sig = getSignaling(conn);
      sig.emit('tombstone-event', 'hash-pinned-p', 'forged-data');

      expect(mockClearPeerPWA).not.toHaveBeenCalled();
      expect(tombstonedHandler).not.toHaveBeenCalled();
    });

    it('second verified tombstone is a no-op once state is "closed" (idempotency)', () => {
      // First event: transitions paired → closed.
      mockIsPaired.mockReturnValue(true);
      mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
      mockVerifyTombstonePayload.mockReturnValue({
        status: 'tombstoned',
        tombstone: {
          type: 'rotated',
          oldPublicKey: 'pinned-peer-pub',
          signature: 'sig',
        },
      });
      // clearPeerPWA side effect: config flips to closed=true.
      mockClearPeerPWA.mockImplementationOnce(() => {
        mockLoadConfig.mockReturnValue({
          ...PAIRED_CONFIG,
          peerPWAPublicKey: null,
          peerPWASignPublicKey: null,
          closed: true,
        });
      });
      const tombstonedHandler = vi.fn();
      conn.on('tombstoned', tombstonedHandler);

      const sig = getSignaling(conn);
      sig.emit('tombstone-event', 'hash-pinned-p', 'first');
      // Second event (e.g. catch-up GET races with push): should be ignored
      // because getState() now reports 'closed'.
      sig.emit('tombstone-event', 'hash-pinned-p', 'second');

      expect(mockClearPeerPWA).toHaveBeenCalledTimes(1);
      expect(tombstonedHandler).toHaveBeenCalledTimes(1);
    });

    it('start() launches the 180s periodic catch-up fallback', async () => {
      vi.useFakeTimers();
      try {
        mockIsPaired.mockReturnValue(true);
        mockLoadConfig.mockReturnValue(PAIRED_CONFIG);
        mockCheckTombstone.mockResolvedValue({ status: 'absent' });

        await conn.start();

        // No polling fire yet.
        expect(mockCheckTombstone).toHaveBeenCalledTimes(0);

        // Advance past one 180s window → one GET call.
        await vi.advanceTimersByTimeAsync(180_000);
        expect(mockCheckTombstone).toHaveBeenCalledTimes(1);

        // Two more windows → two more calls.
        await vi.advanceTimersByTimeAsync(180_000 * 2);
        expect(mockCheckTombstone).toHaveBeenCalledTimes(3);

        // disconnect() clears the interval.
        conn.disconnect();
        await vi.advanceTimersByTimeAsync(180_000 * 5);
        expect(mockCheckTombstone).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
