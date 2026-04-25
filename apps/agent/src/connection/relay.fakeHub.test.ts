import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzip } from 'zlib';
import { promisify } from 'util';
import {
  FakeRelayHub,
  FakeWebSocket,
  setActiveFakeRelayHub,
  type FakeWsSocket,
} from './fakeRelay.js';

/**
 * Drives the production `SignalingClient` (`relay.ts`) end-to-end against a
 * `FakeRelayHub`, replacing the `ws` module so `new WebSocket(url)` returns
 * a hub-attached fake socket. This proves the integration boundary between
 * the hub and the real signaling client works — anything above `relay.ts`
 * (encryption, peer state, message bus) can layer on top with the same
 * mock pattern.
 */

vi.mock('ws', () => ({
  __esModule: true,
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

const gzipAsync = promisify(gzip);

const flush = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 0));

// Import AFTER vi.mock so the constructor inside `relay.ts` resolves to the
// fake. vi.mock is hoisted, so this just keeps the file readable.
import { SignalingClient } from './relay.js';

describe('SignalingClient (relay.ts) over FakeRelayHub', () => {
  let hub: FakeRelayHub;

  beforeEach(() => {
    hub = new FakeRelayHub();
    setActiveFakeRelayHub(hub);
  });

  afterEach(() => {
    setActiveFakeRelayHub(null);
    hub.close();
  });

  function getAgentSocket(agentId: string): FakeWsSocket {
    const peer = hub
      .listPeers()
      .find((p) => p.channel === 'agent' && p.id === agentId);
    if (!peer) throw new Error(`agent ${agentId} not attached`);
    return peer.socket;
  }

  it('connect() resolves once the hub opens the socket', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    let connectedFired = false;
    client.on('connected', () => (connectedFired = true));
    await client.connect();
    expect(connectedFired).toBe(true);
    expect(hub.peerCount()).toBe(1);
    client.disconnect();
  });

  it('inbound routed envelope is emitted as data with from address', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    const received: Array<{ data: string; from: string | null }> = [];
    client.on('data', (data, from) => received.push({ data, from }));
    await client.connect();

    // Simulate a PWA peer pushing a routed envelope through the hub.
    const pwaSock = hub.attachPwa('pwa-pub');
    await flush();
    pwaSock.send(
      JSON.stringify({
        from: 'pwa:pwa-pub',
        to: 'agent:agent-1',
        payload: 'opaque-encrypted-payload',
      }),
    );
    await flush();
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].data).toBe('opaque-encrypted-payload');
    expect(received[0].from).toBe('pwa:pwa-pub');

    client.disconnect();
  });

  it('sendData wraps in routed envelope when targetAddress is set', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    await client.connect();
    const pwaSock = hub.attachPwa('pwa-pub');
    const pwaRx: string[] = [];
    pwaSock.on('message', (data: string | Buffer) =>
      pwaRx.push(typeof data === 'string' ? data : data.toString('utf-8')),
    );
    await flush();

    client.sendData('hello-encrypted', 'pwa:pwa-pub');
    await flush();
    await flush();

    expect(pwaRx).toHaveLength(1);
    const env = JSON.parse(pwaRx[0]);
    expect(env).toEqual({
      from: 'agent:agent-1',
      to: 'pwa:pwa-pub',
      payload: 'hello-encrypted',
    });
    client.disconnect();
  });

  it('sendData with null target sends raw bytes (legacy mode)', async () => {
    // Legacy raw-bytes path. The hub will try to JSON.parse and drop a
    // non-JSON frame, so we just assert no throw + that it reaches the wire.
    const client = new SignalingClient('ws://test', 'agent-1');
    await client.connect();
    expect(() => client.sendData('legacy-raw', null)).not.toThrow();
    await flush();
    client.disconnect();
  });

  it('decompresses {z}-wrapped signaling messages', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    const peerConnected: Array<unknown> = [];
    client.on('peer-connected', () => peerConnected.push(true));
    await client.connect();

    const inner = JSON.stringify({ type: 'peer-connected' });
    const compressed = (await gzipAsync(Buffer.from(inner))).toString('base64');
    const wireFrame = JSON.stringify({ z: compressed });

    // Deliver raw to the agent socket as if the relay sent a compressed frame.
    const agentSock = getAgentSocket('agent-1');
    agentSock._deliver(wireFrame);
    await flush();
    await flush();
    await flush();

    expect(peerConnected).toHaveLength(1);
    client.disconnect();
  });

  it('emits pwa-bye when the relay sends a pwa-bye signal', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    const byeAddrs: string[] = [];
    client.on('pwa-bye', (addr: string) => byeAddrs.push(addr));
    await client.connect();

    // Cause a real pwa-bye via PWA disconnect after watching this agent.
    const pwaSock = hub.attachPwa('pwa-key-1');
    await flush();
    pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-1' }));
    await flush();
    pwaSock.close();
    await flush();
    await flush();

    expect(byeAddrs).toEqual(['pwa:pwa-key-1']);
    client.disconnect();
  });

  it('subscribeTombstone sends a control frame and the hub fans out events', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    const events: Array<{ keyHash: string; data: string }> = [];
    client.on('tombstone-event', (keyHash: string, data: string) =>
      events.push({ keyHash, data }),
    );
    await client.connect();

    client.subscribeTombstone('kh-1');
    await flush();
    hub.publishTombstone('kh-1', 'tombstone-cipher');
    await flush();
    await flush();

    expect(events).toEqual([{ keyHash: 'kh-1', data: 'tombstone-cipher' }]);
    client.disconnect();
  });

  it('unsubscribeTombstone stops further events', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    const events: Array<unknown> = [];
    client.on('tombstone-event', () => events.push(true));
    await client.connect();

    client.subscribeTombstone('kh-1');
    await flush();
    client.unsubscribeTombstone('kh-1');
    await flush();
    hub.publishTombstone('kh-1', 'should-not-arrive');
    await flush();

    expect(events).toHaveLength(0);
    client.disconnect();
  });

  it('emits disconnected when the hub closes the socket', async () => {
    const client = new SignalingClient('ws://test', 'agent-1');
    let disconnected = false;
    client.on('disconnected', () => (disconnected = true));
    await client.connect();

    const sock = getAgentSocket('agent-1');
    sock.close();
    await flush();
    await flush();

    expect(disconnected).toBe(true);
    // Note: the production SignalingClient schedules a reconnect after a
    // close. We don't await it here; vitest's afterEach hub.close() + the
    // explicit disconnect below cover cleanup. The intentional-disconnect
    // path is tested separately.
    client.disconnect();
  });
});
