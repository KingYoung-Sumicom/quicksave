import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRelay, sendMessage } from '@sumicom/ws-relay';
import type { RelayInstance, Peer, PeerRegistryInterface } from '@sumicom/ws-relay';
import WebSocket from 'ws';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_PORT = 18090;

function wsUrl(path: string): string {
  return `ws://localhost:${TEST_PORT}${path}`;
}

function connect(path: string): WebSocket {
  return new WebSocket(wsUrl(path));
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        reject(new Error('Non-JSON message: ' + data.toString()));
      }
    });
    ws.once('error', reject);
  });
}

// ── Test relay setup (mirrors index.ts but on a test port) ─────────────────

function createTestRelay(): RelayInstance {
  const agentWatchers = new Map<string, Set<string>>();

  let relay!: RelayInstance;

  relay = createRelay({
    port: TEST_PORT,
    keyStore: false,
    blobStore: false,
    channels: [
      { name: 'agent', onDuplicate: 'reject' },
      {
        name: 'pwa',
        onDuplicate: 'replace',
        parseId: (raw) => {
          try {
            const decoded = decodeURIComponent(raw);
            return decoded.length >= 8 ? decoded : null;
          } catch {
            return null;
          }
        },
      },
    ],
    hooks: {
      onPeerConnect(peer: Peer, registry: PeerRegistryInterface) {
        if (peer.channel === 'agent') {
          const watchers = agentWatchers.get(peer.id) ?? new Set<string>();
          for (const pwaAddr of watchers) {
            const pwaPeer = registry.getByAddress(pwaAddr);
            if (pwaPeer && pwaPeer.ws.readyState === WebSocket.OPEN) {
              sendMessage(pwaPeer.ws, { type: 'agent-status', payload: { agentId: peer.id, online: true } });
            }
          }
        }
      },
      onPeerDisconnect(peer: Peer, registry: PeerRegistryInterface) {
        if (peer.channel === 'agent') {
          const watchers = agentWatchers.get(peer.id) ?? new Set<string>();
          for (const pwaAddr of watchers) {
            const pwaPeer = registry.getByAddress(pwaAddr);
            if (pwaPeer && pwaPeer.ws.readyState === WebSocket.OPEN) {
              sendMessage(pwaPeer.ws, { type: 'agent-status', payload: { agentId: peer.id, online: false } });
            }
          }
        }
        if (peer.channel === 'pwa') {
          for (const [agentId, watchers] of agentWatchers) {
            if (watchers.has(peer.address)) {
              watchers.delete(peer.address);
              if (watchers.size === 0) agentWatchers.delete(agentId);
              const agentPeer = registry.get('agent', agentId);
              if (agentPeer && agentPeer.ws.readyState === WebSocket.OPEN) {
                sendMessage(agentPeer.ws, { type: 'pwa-bye', payload: { pwaAddress: peer.address } });
              }
            }
          }
        }
      },
      onMessage(peer: Peer, msg: unknown, _raw: Buffer, registry: PeerRegistryInterface) {
        if (typeof msg !== 'object' || msg === null) return;
        const m = msg as Record<string, unknown>;
        if (m.type === 'watch-agent' && typeof m.agentId === 'string' && peer.channel === 'pwa') {
          const agentId = m.agentId;
          let watchers = agentWatchers.get(agentId);
          if (!watchers) {
            watchers = new Set();
            agentWatchers.set(agentId, watchers);
          }
          watchers.add(peer.address);
          const agentPeer = registry.get('agent', agentId);
          sendMessage(peer.ws, { type: 'agent-status', payload: { agentId, online: !!agentPeer } });
          return true;
        }
      },
    },
  });

  return relay;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('signaling server', () => {
  let relay: RelayInstance;
  const sockets: WebSocket[] = [];

  function track(ws: WebSocket): WebSocket {
    sockets.push(ws);
    return ws;
  }

  beforeEach(() => {
    relay = createTestRelay();
  });

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets.length = 0;
    await new Promise<void>((resolve) => relay.server.close(() => resolve()));
    relay.close();
  });

  describe('agent channel', () => {
    it('connects at /agent/{id}', async () => {
      const ws = track(connect('/agent/agent-abc-1234'));
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('rejects duplicate agent ID', async () => {
      const ws1 = track(connect('/agent/agent-dup-1234'));
      await waitForOpen(ws1);

      const ws2 = track(connect('/agent/agent-dup-1234'));
      const msg = await waitForMessage(ws2);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('ID_IN_USE');
    });

    it('rejects invalid URL', async () => {
      const ws = track(new WebSocket(`ws://localhost:${TEST_PORT}/unknown/path`));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_URL');
    });
  });

  describe('pwa channel', () => {
    it('connects at /pwa/{publicKey}', async () => {
      const key = encodeURIComponent('myPublicKey12345');
      const ws = track(connect(`/pwa/${key}`));
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('replaces duplicate PWA connection and sends REPLACED error', async () => {
      const key = encodeURIComponent('dupPublicKey1234');
      const ws1 = track(connect(`/pwa/${key}`));
      await waitForOpen(ws1);

      const ws2 = track(connect(`/pwa/${key}`));
      const msg = await waitForMessage(ws1);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('REPLACED');

      await waitForOpen(ws2);
      expect(ws2.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('watch-agent / agent-status', () => {
    it('watch-agent returns offline status when agent is not connected', async () => {
      const pwaKey = encodeURIComponent('pwaPublicKey12345');
      const pwa = track(connect(`/pwa/${pwaKey}`));
      await waitForOpen(pwa);

      pwa.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-offline-xx' }));
      const msg = await waitForMessage(pwa);

      expect(msg.type).toBe('agent-status');
      const payload = msg.payload as Record<string, unknown>;
      expect(payload.agentId).toBe('agent-offline-xx');
      expect(payload.online).toBe(false);
    });

    it('watch-agent returns online status when agent is connected', async () => {
      const agent = track(connect('/agent/agent-online-xx'));
      await waitForOpen(agent);

      const pwaKey = encodeURIComponent('pwaPublicKey12345');
      const pwa = track(connect(`/pwa/${pwaKey}`));
      await waitForOpen(pwa);

      pwa.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-online-xx' }));
      const msg = await waitForMessage(pwa);

      expect(msg.type).toBe('agent-status');
      const payload = msg.payload as Record<string, unknown>;
      expect(payload.agentId).toBe('agent-online-xx');
      expect(payload.online).toBe(true);
    });

    it('notifies PWA when watched agent comes online', async () => {
      const pwaKey = encodeURIComponent('pwaPublicKey12345');
      const pwa = track(connect(`/pwa/${pwaKey}`));
      await waitForOpen(pwa);

      // Watch before agent connects
      pwa.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-late-xxxx' }));
      const offlineMsg = await waitForMessage(pwa);
      expect((offlineMsg.payload as Record<string, unknown>).online).toBe(false);

      // Now agent connects
      const agent = track(connect('/agent/agent-late-xxxx'));
      await waitForOpen(agent);

      const onlineMsg = await waitForMessage(pwa);
      expect(onlineMsg.type).toBe('agent-status');
      expect((onlineMsg.payload as Record<string, unknown>).online).toBe(true);
    });

    it('notifies PWA when watched agent goes offline', async () => {
      const agent = track(connect('/agent/agent-bye-xxxxx'));
      await waitForOpen(agent);

      const pwaKey = encodeURIComponent('pwaPublicKey12345');
      const pwa = track(connect(`/pwa/${pwaKey}`));
      await waitForOpen(pwa);

      pwa.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-bye-xxxxx' }));
      const onlineMsg = await waitForMessage(pwa);
      expect((onlineMsg.payload as Record<string, unknown>).online).toBe(true);

      // Agent disconnects
      agent.close();
      const offlineMsg = await waitForMessage(pwa);
      expect(offlineMsg.type).toBe('agent-status');
      expect((offlineMsg.payload as Record<string, unknown>).online).toBe(false);
    });
  });

  describe('pwa-bye', () => {
    it('notifies agent when a watching PWA disconnects', async () => {
      const agent = track(connect('/agent/agent-pwabye-xx'));
      await waitForOpen(agent);

      const pwaKey = encodeURIComponent('pwaPublicKey12345');
      const pwa = track(connect(`/pwa/${pwaKey}`));
      await waitForOpen(pwa);

      // PWA subscribes to agent
      pwa.send(JSON.stringify({ type: 'watch-agent', agentId: 'agent-pwabye-xx' }));
      await waitForMessage(pwa); // consume agent-status

      // PWA disconnects
      pwa.close();
      const msg = await waitForMessage(agent);
      expect(msg.type).toBe('pwa-bye');
      const payload = msg.payload as Record<string, unknown>;
      expect(typeof payload.pwaAddress).toBe('string');
      expect((payload.pwaAddress as string).startsWith('pwa:')).toBe(true);
    });
  });

  describe('routed messages', () => {
    it('routes messages between agent and pwa using from/to', async () => {
      const agentId = 'agent-routed-xx';
      const pwaKey = 'pwaPublicKey12345';

      const agent = track(connect(`/agent/${agentId}`));
      await waitForOpen(agent);

      const pwa = track(connect(`/pwa/${encodeURIComponent(pwaKey)}`));
      await waitForOpen(pwa);

      // Agent sends to PWA
      agent.send(JSON.stringify({
        from: `agent:${agentId}`,
        to: `pwa:${pwaKey}`,
        payload: 'hello from agent',
      }));

      const received = await waitForMessage(pwa);
      expect(received.from).toBe(`agent:${agentId}`);
      expect(received.payload).toBe('hello from agent');
    });

    it('rejects messages where from does not match sender identity', async () => {
      const agent = track(connect('/agent/agent-spoofed'));
      await waitForOpen(agent);

      agent.send(JSON.stringify({
        from: 'agent:someone-else',
        to: 'pwa:somepwa',
        payload: 'spoofed',
      }));

      const msg = await waitForMessage(agent);
      expect(msg.type).toBe('error');
      expect((msg.payload as Record<string, unknown>).code).toBe('INVALID_FROM');
    });
  });
});
