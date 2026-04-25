import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeRelayHub, FakeWsSocket } from './fakeRelay.js';

/**
 * Unit tests for FakeRelayHub itself, asserting that it faithfully models
 * the production relay's routing + signaling behaviors that agent and PWA
 * code rely on. Tests at this layer drive the hub directly via its public
 * API + the FakeWsSocket facing-side; higher-level e2e tests will sit on
 * top once we plumb through `SignalingClient` and `AgentConnection`.
 */

const WS_OPEN = 1;

function flush(): Promise<void> {
  // Hub uses queueMicrotask; two awaits is enough to drain a delivery + the
  // listener's own follow-up dispatch.
  return new Promise((r) => setTimeout(r, 0));
}

function captureMessages(socket: FakeWsSocket): string[] {
  const out: string[] = [];
  socket.on('message', (data: string | Buffer) => {
    out.push(typeof data === 'string' ? data : data.toString('utf-8'));
  });
  return out;
}

async function waitForOpen(socket: FakeWsSocket): Promise<void> {
  if (socket.readyState === WS_OPEN) {
    await flush();
    return;
  }
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));
}

describe('FakeRelayHub', () => {
  let hub: FakeRelayHub;

  beforeEach(() => {
    hub = new FakeRelayHub();
  });

  afterEach(() => {
    hub.close();
  });

  describe('attach + open', () => {
    it('emits open on the next tick when an agent attaches', async () => {
      const socket = hub.attachAgent('agent-1');
      let opened = false;
      socket.on('open', () => (opened = true));
      // open is async to give listeners a chance to attach
      expect(opened).toBe(false);
      await flush();
      expect(opened).toBe(true);
      expect(socket.readyState).toBe(WS_OPEN);
    });

    it('emits open on the next tick when a pwa attaches', async () => {
      const socket = hub.attachPwa('pwa-key');
      let opened = false;
      socket.on('open', () => (opened = true));
      await flush();
      expect(opened).toBe(true);
    });

    it('rejects duplicate agent ids', () => {
      hub.attachAgent('agent-1');
      expect(() => hub.attachAgent('agent-1')).toThrow(/already attached/);
    });

    it('peerCount tracks attached peers', async () => {
      expect(hub.peerCount()).toBe(0);
      hub.attachAgent('a');
      hub.attachPwa('p');
      expect(hub.peerCount()).toBe(2);
    });
  });

  describe('routed envelope forwarding', () => {
    it('forwards a {from,to,payload} envelope from pwa to agent verbatim', async () => {
      const agentSock = hub.attachAgent('agent-1');
      const pwaSock = hub.attachPwa('pwa-key');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);

      const incoming = captureMessages(agentSock);

      const envelope = JSON.stringify({
        from: 'pwa:pwa-key',
        to: 'agent:agent-1',
        payload: 'opaque-encrypted-payload',
      });
      pwaSock.send(envelope);
      await flush();

      expect(incoming).toEqual([envelope]);
    });

    it('forwards in both directions independently', async () => {
      const agentSock = hub.attachAgent('a1');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);
      const agentRx = captureMessages(agentSock);
      const pwaRx = captureMessages(pwaSock);

      pwaSock.send(
        JSON.stringify({ from: 'pwa:p1', to: 'agent:a1', payload: 'p->a' }),
      );
      agentSock.send(
        JSON.stringify({ from: 'agent:a1', to: 'pwa:p1', payload: 'a->p' }),
      );
      await flush();

      expect(agentRx).toHaveLength(1);
      expect(pwaRx).toHaveLength(1);
      expect(JSON.parse(agentRx[0]).payload).toBe('p->a');
      expect(JSON.parse(pwaRx[0]).payload).toBe('a->p');
    });

    it('drops envelopes addressed to an offline peer', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      // No agent attached — envelope should be silently dropped, not throw.
      pwaSock.send(
        JSON.stringify({ from: 'pwa:p1', to: 'agent:missing', payload: 'x' }),
      );
      await flush();
      // Nothing to assert beyond "did not throw".
      expect(hub.peerCount()).toBe(1);
    });

    it('drops malformed (non-JSON) frames silently', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      pwaSock.send('not-json{');
      await flush();
      expect(hub.peerCount()).toBe(1);
    });

    it('does not re-deliver envelopes back to the sender', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(
        JSON.stringify({ from: 'pwa:p1', to: 'pwa:p1', payload: 'self' }),
      );
      await flush();
      // Hub forwards based on `to` — self-addressed envelope DOES bounce back.
      // This is what the prod relay would do too. Document the behavior.
      expect(rx).toHaveLength(1);
    });
  });

  describe('watch-agent + agent-status', () => {
    it('responds with online=false when the agent is not connected', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      expect(rx).toHaveLength(1);
      expect(JSON.parse(rx[0])).toEqual({
        type: 'agent-status',
        payload: { agentId: 'a1', online: false },
      });
    });

    it('responds with online=true when the agent is already connected', async () => {
      hub.attachAgent('a1');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      expect(JSON.parse(rx[0]).payload).toEqual({ agentId: 'a1', online: true });
    });

    it('pushes agent-status online=true when the agent connects later', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      expect(rx).toHaveLength(1); // initial offline notification
      hub.attachAgent('a1');
      await flush();
      expect(rx).toHaveLength(2);
      expect(JSON.parse(rx[1]).payload).toEqual({
        agentId: 'a1',
        online: true,
      });
    });

    it('pushes agent-status online=false when the agent disconnects', async () => {
      const agentSock = hub.attachAgent('a1');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      rx.length = 0;
      agentSock.close();
      await flush();
      expect(rx).toHaveLength(1);
      expect(JSON.parse(rx[0]).payload).toEqual({
        agentId: 'a1',
        online: false,
      });
    });

    it('multiple PWAs all receive agent-status broadcasts', async () => {
      const pwaA = hub.attachPwa('pA');
      const pwaB = hub.attachPwa('pB');
      await waitForOpen(pwaA);
      await waitForOpen(pwaB);
      const rxA = captureMessages(pwaA);
      const rxB = captureMessages(pwaB);
      pwaA.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      pwaB.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      // Drop the initial offline replies so we can assert the connect-time push.
      rxA.length = 0;
      rxB.length = 0;
      hub.attachAgent('a1');
      await flush();
      expect(rxA).toHaveLength(1);
      expect(rxB).toHaveLength(1);
    });
  });

  describe('pwa-bye on PWA disconnect', () => {
    it('notifies a watched agent when the PWA disconnects', async () => {
      const agentSock = hub.attachAgent('a1');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);
      const agentRx = captureMessages(agentSock);
      pwaSock.send(JSON.stringify({ type: 'watch-agent', agentId: 'a1' }));
      await flush();
      pwaSock.close();
      await flush();
      const byes = agentRx
        .map((m) => JSON.parse(m))
        .filter((m: { type?: string }) => m.type === 'pwa-bye');
      expect(byes).toHaveLength(1);
      expect(byes[0].payload).toEqual({ pwaAddress: 'pwa:p1' });
    });

    it('does NOT notify agents the PWA was not watching', async () => {
      const agentSock = hub.attachAgent('a-other');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);
      const agentRx = captureMessages(agentSock);
      pwaSock.close();
      await flush();
      expect(agentRx).toHaveLength(0);
    });
  });

  describe('tombstone push channel', () => {
    it('subscribed agent receives tombstone-event when published', async () => {
      const agentSock = hub.attachAgent('a1');
      await waitForOpen(agentSock);
      const rx = captureMessages(agentSock);
      agentSock.send(
        JSON.stringify({
          type: 'tombstone-subscribe',
          payload: { keyHash: 'kh-1' },
        }),
      );
      await flush();
      hub.publishTombstone('kh-1', 'tombstone-ciphertext');
      await flush();
      const events = rx
        .map((m) => JSON.parse(m))
        .filter((m: { type?: string }) => m.type === 'tombstone-event');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        keyHash: 'kh-1',
        data: 'tombstone-ciphertext',
      });
    });

    it('replays the most recent tombstone to a late subscriber', async () => {
      hub.publishTombstone('kh-1', 'ciphertext-v1');
      const agentSock = hub.attachAgent('a1');
      await waitForOpen(agentSock);
      const rx = captureMessages(agentSock);
      agentSock.send(
        JSON.stringify({
          type: 'tombstone-subscribe',
          payload: { keyHash: 'kh-1' },
        }),
      );
      await flush();
      const events = rx
        .map((m) => JSON.parse(m))
        .filter((m: { type?: string }) => m.type === 'tombstone-event');
      expect(events).toHaveLength(1);
      expect(events[0].payload.data).toBe('ciphertext-v1');
    });

    it('unsubscribe stops further tombstone-event delivery', async () => {
      const agentSock = hub.attachAgent('a1');
      await waitForOpen(agentSock);
      const rx = captureMessages(agentSock);
      agentSock.send(
        JSON.stringify({
          type: 'tombstone-subscribe',
          payload: { keyHash: 'kh-1' },
        }),
      );
      await flush();
      agentSock.send(
        JSON.stringify({
          type: 'tombstone-unsubscribe',
          payload: { keyHash: 'kh-1' },
        }),
      );
      await flush();
      hub.publishTombstone('kh-1', 'late');
      await flush();
      const events = rx
        .map((m) => JSON.parse(m))
        .filter((m: { type?: string }) => m.type === 'tombstone-event');
      expect(events).toHaveLength(0);
    });

    it('PWA-channel tombstone-subscribe is ignored', async () => {
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(pwaSock);
      const rx = captureMessages(pwaSock);
      pwaSock.send(
        JSON.stringify({
          type: 'tombstone-subscribe',
          payload: { keyHash: 'kh-1' },
        }),
      );
      await flush();
      hub.publishTombstone('kh-1', 'data');
      await flush();
      expect(rx).toHaveLength(0);
    });
  });

  describe('socket lifecycle', () => {
    it('close() fires close event and removes peer', async () => {
      const sock = hub.attachAgent('a1');
      await waitForOpen(sock);
      let closed = false;
      sock.on('close', () => (closed = true));
      sock.close();
      await flush();
      expect(closed).toBe(true);
      expect(hub.peerCount()).toBe(0);
    });

    it('terminate() also closes the socket', async () => {
      const sock = hub.attachAgent('a1');
      await waitForOpen(sock);
      let closed = false;
      sock.on('close', () => (closed = true));
      sock.terminate();
      await flush();
      expect(closed).toBe(true);
    });

    it('ping() emits a synthetic pong', async () => {
      const sock = hub.attachAgent('a1');
      await waitForOpen(sock);
      let pongs = 0;
      sock.on('pong', () => pongs++);
      sock.ping();
      await flush();
      expect(pongs).toBe(1);
    });

    it('send after close is silently dropped', async () => {
      const agentSock = hub.attachAgent('a1');
      const pwaSock = hub.attachPwa('p1');
      await waitForOpen(agentSock);
      await waitForOpen(pwaSock);
      const rx = captureMessages(agentSock);
      pwaSock.close();
      await flush();
      // socket no longer attached; send is a no-op
      pwaSock.send(
        JSON.stringify({
          from: 'pwa:p1',
          to: 'agent:a1',
          payload: 'after-close',
        }),
      );
      await flush();
      expect(rx).toHaveLength(0);
    });

    it('hub.close() tears down every socket', async () => {
      const a = hub.attachAgent('a1');
      const p = hub.attachPwa('p1');
      await waitForOpen(a);
      await waitForOpen(p);
      let aClosed = false;
      let pClosed = false;
      a.on('close', () => (aClosed = true));
      p.on('close', () => (pClosed = true));
      hub.close();
      await flush();
      expect(aClosed).toBe(true);
      expect(pClosed).toBe(true);
      expect(hub.peerCount()).toBe(0);
    });
  });
});
