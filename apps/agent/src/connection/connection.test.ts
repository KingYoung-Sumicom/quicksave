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
} = vi.hoisted(() => {
  const { EventEmitter } = require('events');

  class MockSignalingClient extends EventEmitter {
    connectCalled = false;
    sentMessages: Array<{ data: string; target: string | null }> = [];

    constructor(_url: string, _agentId: string) {
      super();
    }

    async connect(): Promise<void> {
      this.connectCalled = true;
    }

    sendData(data: string, targetAddress: string | null): void {
      this.sentMessages.push({ data, target: targetAddress });
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
  };
});

vi.mock('./relay.js', () => ({
  SignalingClient: MockSignalingClient,
}));

vi.mock('@sumicom/quicksave-shared', () => ({
  generateKeyPair: vi.fn(),
  encodeKeyPair: vi.fn(),
  decodeKeyPair: mockDecodeKeyPair,
  encryptWithSharedSecret: mockEncryptWithSharedSecret,
  decryptWithSharedSecret: mockDecryptWithSharedSecret,
  decryptDEK: mockDecryptDEK,
  parseMessage: mockParseMessage,
  serializeMessage: mockSerializeMessage,
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
function addPeer(conn: AgentConnection, address: string): void {
  const sig = getSignaling(conn);
  const keyExchange = JSON.stringify({
    type: 'key-exchange',
    version: 2,
    encryptedDEK: 'encrypted-dek-base64',
    timestamp: Date.now(),
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
});
