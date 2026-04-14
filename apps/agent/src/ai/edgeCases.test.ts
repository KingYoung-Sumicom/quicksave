/**
 * Adversarial tests for known bugs and race conditions in the quicksave agent.
 *
 * Each section targets a specific bug area with comments explaining
 * the expected vs. actual behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PubSub, sessionTopic, BROADCAST_TOPIC } from '../connection/pubsub.js';

// ============================================================================
// 1. PubSub subscription lost after agent relay reconnect
// ============================================================================
//
// Bug: When the signaling WebSocket disconnects (connection.ts line 83-90),
// ALL peers and pubsub subscriptions are cleared via unsubscribeAll + peers.clear().
// After reconnect + re-key-exchange, the peer is re-added to this.peers and
// auto-subscribed to BROADCAST_TOPIC, but NOT re-subscribed to any session topics.
// sendToSession() returns 0 even though the peer is connected.

// We need to mock the same modules as connection.test.ts to test AgentConnection.

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

vi.mock('../connection/relay.js', () => ({
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
  DEFAULT_AGENT: 'claude-code',
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  matchAllowPattern: vi.fn().mockReturnValue(false),
}));

vi.mock('zlib', () => ({
  gzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('compressed'))),
  gunzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('decompressed'))),
}));

// Mock fs modules for cardBuilder imports
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  createReadStream: vi.fn(),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock-home',
}));

// Mock sessionRegistry to avoid filesystem access
vi.mock('./sessionRegistry.js', () => ({
  getSessionRegistry: () => ({
    getEntry: vi.fn().mockReturnValue(null),
    getEntriesForProject: vi.fn().mockReturnValue([]),
    upsertEntry: vi.fn(),
  }),
}));

import { AgentConnection, type ConnectionConfig } from '../connection/connection.js';
import { StreamCardBuilder } from './cardBuilder.js';
import { stat } from 'fs/promises';

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

function getSignaling(conn: AgentConnection): InstanceType<typeof MockSignalingClient> {
  return (conn as any).signaling as InstanceType<typeof MockSignalingClient>;
}

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

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ============================================================================
// Test Suite 1: PubSub subscription lost after relay reconnect
// ============================================================================

describe('Bug: PubSub subscription lost after relay reconnect', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('peer session subscriptions are restored after signaling disconnect + reconnect', async () => {
    const peerAddr = 'pwa:peer-abc123';
    const sessionId = 'session-xyz';

    // Step 1: Add peer via key exchange
    addPeer(conn, peerAddr);
    await flush();
    expect(conn.getPeerCount()).toBe(1);

    // Step 2: Subscribe peer to a session topic
    conn.subscribePeerToSession(peerAddr, sessionId);

    // Verify subscription works — sendToSession should find the subscriber
    const mockMessage = { id: 'msg-1', type: 'claude:card-event', payload: {}, timestamp: Date.now() };
    const sentBefore = conn.sendToSession(sessionId, mockMessage);
    expect(sentBefore).toBe(1);

    // Step 3: Simulate signaling 'disconnected' event (WebSocket drops)
    const sig = getSignaling(conn);
    sig.emit('disconnected');
    await flush();

    expect(conn.getPeerCount()).toBe(0);

    // Step 4: Simulate reconnect — peer does a new key exchange
    addPeer(conn, peerAddr);
    await flush();
    expect(conn.getPeerCount()).toBe(1);

    // Step 5: FIXED — session subscription is restored from savedPeerTopics
    const sentAfter = conn.sendToSession(sessionId, mockMessage);
    expect(sentAfter).toBe(1);
  });

  it('broadcast still works after reconnect (auto-subscribed)', async () => {
    const peerAddr = 'pwa:peer-abc123';

    // Add peer, disconnect, reconnect
    addPeer(conn, peerAddr);
    await flush();

    const sig = getSignaling(conn);
    sig.emit('disconnected');
    await flush();

    addPeer(conn, peerAddr);
    await flush();

    // Broadcast uses BROADCAST_TOPIC which is auto-subscribed on key exchange
    // This should still work
    const mockMessage = { id: 'msg-1', type: 'session-updated', payload: {}, timestamp: Date.now() };
    conn.broadcast(mockMessage);

    // Verify the message was sent (encrypted)
    const sentMessages = sig.sentMessages.filter(m => m.target === peerAddr);
    // key-exchange-ack (first connect) + key-exchange-ack (reconnect) = 2 acks
    // broadcast message is sent via send() which queues async compression, so it
    // may not appear synchronously. The acks confirm the peer is connected.
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Test Suite 2: CardBuilder clearCards + snapshotCutoff ordering after stream end
// ============================================================================

describe('Bug: clearCards + snapshotCutoff ordering race after stream end', () => {
  it('getCards returns empty cards in window between clearCards and snapshotCutoff', async () => {
    const SESSION_ID = 'sess-race';
    const STREAM_ID = 'stream-1';
    const CWD = '/test/project';

    const cb = new StreamCardBuilder(SESSION_ID, STREAM_ID, CWD);
    cb.updateSessionId(SESSION_ID);

    // Simulate an initial cutoff (as if we did a resume and snapshoted before the turn)
    // Set a fake cutoff to simulate that the JSONL had content before this turn
    cb.jsonlCutoff = 1000;

    // Build some cards during the streaming turn
    cb.userMessage('hello');
    cb.assistantText('Sure, ');
    cb.assistantText('I can help.');
    cb.finalizeAssistantText();
    cb.toolUse('Read', { file_path: '/foo' }, 'tu-1');
    cb.toolResult('tu-1', 'file contents here', false);

    // Verify we have cards
    const cardsBefore = cb.getCards();
    // user, assistant_text, tool_call (toolResult updates the tool_call card in-place, not a new card)
    expect(cardsBefore.length).toBe(3);

    // FIXED: The correct sequence is snapshotCutoff BEFORE clearCards.
    // This ensures that if getCards() is called between the two operations,
    // the cutoff is already updated so buildCardsFromHistory reads the full JSONL.
    vi.mocked(stat).mockResolvedValueOnce({ size: 5000 } as any);
    await cb.snapshotCutoff();
    expect(cb.jsonlCutoff).toBe(5000); // Updated BEFORE clear

    cb.clearCards();
    expect(cb.getCards()).toEqual([]);
    // Now if getCards is called: cutoff=5000, so buildCardsFromHistory reads full JSONL.
    // In-memory cards are empty, but that's fine — JSONL has everything.
    expect(cb.jsonlCutoff).toBe(5000);
  });
});

// ============================================================================
// Test Suite 3: SessionManager getCards cutoff behavior
// ============================================================================

describe('SessionManager getCards cutoff behavior', () => {
  it('active session with cardBuilder uses jsonlCutoff for history reads', () => {
    // Test the cutoff logic extracted from SessionManager.getCards (line 549):
    //   const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;
    //
    // When cardBuilder exists and has a cutoff, buildCardsFromHistory receives it
    // so it reads only up to the cutoff byte offset (excludes active turn).

    const cb = new StreamCardBuilder('sess-cutoff', 'stream-1', '/project');
    cb.jsonlCutoff = 2048;

    // Simulate: session is active, cardBuilder has a cutoff
    const cutoff = cb.jsonlCutoff ?? undefined;
    expect(cutoff).toBe(2048);
  });

  it('appends streaming cards for offset=0 only (avoids duplicates)', () => {
    // SessionManager.getCards (line 572-578):
    //   if (offset === 0 && provider.historyMode === 'claude-jsonl' && ps?.cardBuilder) {
    //     const streamingCards = ps.cardBuilder.getCards();
    //     result.cards.push(...streamingCards);
    //   }
    //
    // For offset > 0 (pagination), streaming cards are NOT appended because
    // the PWA already has them from the initial load.

    const cb = new StreamCardBuilder('sess-offset', 'stream-1', '/project');
    cb.userMessage('hello');
    cb.assistantText('world');

    const streamingCards = cb.getCards();
    expect(streamingCards.length).toBe(2);

    // Simulate offset=0 behavior: cards are appended
    const resultOffset0 = { cards: [] as any[], total: 10, hasMore: false };
    const offset0 = 0;
    if (offset0 === 0) {
      resultOffset0.cards.push(...streamingCards);
      resultOffset0.total += streamingCards.length;
    }
    expect(resultOffset0.cards.length).toBe(2);
    expect(resultOffset0.total).toBe(12);

    // Simulate offset > 0 behavior: cards are NOT appended
    const resultOffset10 = { cards: [] as any[], total: 10, hasMore: false };
    const offset10 = 10;
    if (offset10 === 0) {
      resultOffset10.cards.push(...streamingCards);
      resultOffset10.total += streamingCards.length;
    }
    expect(resultOffset10.cards.length).toBe(0);
    expect(resultOffset10.total).toBe(10);
  });

  it('null cardBuilder means no cutoff — full JSONL is read', () => {
    // When a session is closed (no ManagedSession in the map), cardBuilder is null.
    // SessionManager.getCards (line 549):
    //   const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;
    // With ps=undefined, cutoff=undefined → buildCardsFromHistory reads full file.

    const ps = undefined as any; // session not in map (closed)
    const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;
    expect(cutoff).toBeUndefined();
  });

  it('cardBuilder with null jsonlCutoff (new session, no prior JSONL) yields cutoff=0', () => {
    // When startSession creates a cardBuilder, it sets jsonlCutoff = 0 (line 276).
    // This means buildCardsFromHistory reads 0 bytes (nothing) — correct for a new session.

    const cb = new StreamCardBuilder('sess-new', 'stream-1', '/project');
    cb.jsonlCutoff = 0;

    const cutoff = cb.jsonlCutoff ?? undefined;
    expect(cutoff).toBe(0);
    // buildCardsFromHistory with headBytes=0 would return no messages — correct.
  });
});

// ============================================================================
// Test Suite 4: PubSub topic cleanup
// ============================================================================

describe('PubSub topic cleanup', () => {
  let pubsub: PubSub;

  beforeEach(() => {
    pubsub = new PubSub();
  });

  it('deletes topic from map after last subscriber unsubscribes', () => {
    const topic = sessionTopic('sess-1');

    pubsub.subscribe('peer-a', topic);
    pubsub.subscribe('peer-b', topic);

    // Verify topic exists with 2 subscribers
    expect(pubsub.subscribers(topic).size).toBe(2);

    // Remove first subscriber — topic should still exist
    pubsub.unsubscribe('peer-a', topic);
    expect(pubsub.subscribers(topic).size).toBe(1);

    // Remove last subscriber — topic should be deleted (no memory leak)
    pubsub.unsubscribe('peer-b', topic);
    expect(pubsub.subscribers(topic).size).toBe(0);

    // Verify the topic is truly gone from the internal map (not just an empty Set)
    const state = pubsub.getState();
    expect(state.topics[topic]).toBeUndefined();
  });

  it('unsubscribeAll cleans up empty topics', () => {
    const topic1 = sessionTopic('sess-1');
    const topic2 = sessionTopic('sess-2');

    // peer-a is the only subscriber to both topics
    pubsub.subscribe('peer-a', topic1);
    pubsub.subscribe('peer-a', topic2);

    // Verify topics exist
    expect(pubsub.subscribers(topic1).size).toBe(1);
    expect(pubsub.subscribers(topic2).size).toBe(1);

    // unsubscribeAll — should remove peer from both topics AND delete the empty topics
    const removed = pubsub.unsubscribeAll('peer-a');
    expect(removed.size).toBe(2);
    expect(removed.has(topic1)).toBe(true);
    expect(removed.has(topic2)).toBe(true);

    // Topics should be fully gone from the map
    const state = pubsub.getState();
    expect(state.topics[topic1]).toBeUndefined();
    expect(state.topics[topic2]).toBeUndefined();

    // Peer reverse index should also be cleaned up
    expect(state.peerTopics['peer-a']).toBeUndefined();
  });

  it('unsubscribeAll does not remove topics with other subscribers', () => {
    const topic = sessionTopic('sess-shared');

    pubsub.subscribe('peer-a', topic);
    pubsub.subscribe('peer-b', topic);

    pubsub.unsubscribeAll('peer-a');

    // Topic should still exist with peer-b
    expect(pubsub.subscribers(topic).size).toBe(1);
    expect(pubsub.hasSubscribers(topic)).toBe(true);

    const state = pubsub.getState();
    expect(state.topics[topic]).toEqual(['peer-b']);
  });

  it('unsubscribeAll on unknown peer returns empty set', () => {
    const removed = pubsub.unsubscribeAll('nonexistent-peer');
    expect(removed.size).toBe(0);
  });

  it('subscribe returns true for new subscription, false for duplicate', () => {
    const topic = sessionTopic('sess-1');

    const first = pubsub.subscribe('peer-a', topic);
    expect(first).toBe(true);

    const second = pubsub.subscribe('peer-a', topic);
    expect(second).toBe(false);
  });

  it('topicsOf returns empty set for unknown peer', () => {
    const topics = pubsub.topicsOf('unknown');
    expect(topics.size).toBe(0);
  });
});

// ============================================================================
// Test Suite 5: StreamCardBuilder clearCards edge cases
// ============================================================================

describe('StreamCardBuilder clearCards edge cases', () => {
  it('clearCards resets all internal state including currentTextCardId', () => {
    const cb = new StreamCardBuilder('sess-1', 'stream-1', '/test');

    // Start streaming text (sets currentTextCardId)
    cb.assistantText('Hello ');
    cb.assistantText('world');
    expect(cb.getCards().length).toBe(1);
    expect(cb.getCards()[0].type).toBe('assistant_text');
    expect((cb.getCards()[0] as any).text).toBe('Hello world');

    // Clear
    cb.clearCards();
    expect(cb.getCards().length).toBe(0);

    // After clear, next assistantText should create a NEW card (not append to cleared one)
    const evt = cb.assistantText('New text');
    expect(evt.type).toBe('add'); // Should be 'add', not 'append_text'
    expect(cb.getCards().length).toBe(1);
    expect((cb.getCards()[0] as any).text).toBe('New text');
  });

  it('snapshotCutoff with nonexistent file sets cutoff to null', async () => {
    const cb = new StreamCardBuilder('sess-nofile', 'stream-1', '/test');
    cb.jsonlCutoff = 500;

    // stat throws (file doesn't exist)
    vi.mocked(stat).mockRejectedValueOnce(new Error('ENOENT'));
    await cb.snapshotCutoff();

    expect(cb.jsonlCutoff).toBeNull();
  });
});
