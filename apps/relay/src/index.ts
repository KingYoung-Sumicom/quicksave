import { createRelay, sendMessage } from '@sumicom/ws-relay';
import type { RelayInstance, Peer, PeerRegistryInterface } from '@sumicom/ws-relay';
import { WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse } from 'http';
import { SyncStore } from './syncStore.js';

// Injected by esbuild at build time from package.json
declare const VERSION: string;

const PORT = parseInt(process.env.PORT || '8080', 10);

const syncStore = new SyncStore();

// Quicksave-specific agent watcher tracking
// agentId → Set of pwa peer addresses ('pwa:{pwaKey}') watching that agent
const agentWatchers = new Map<string, Set<string>>();

function handleSyncRequest(
  req: IncomingMessage,
  res: ServerResponse,
  keyHash: string,
  isTombstoneRoute: boolean
): void {
  if (req.method === 'GET' && !isTombstoneRoute) {
    const entry = syncStore.get(keyHash);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (entry.type === 'tombstone') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'tombstone', data: entry.data }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'blob', data: entry.data }));
    return;
  }

  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (isTombstoneRoute) {
        try {
          syncStore.putTombstone(keyHash, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          if (message.includes('tombstone')) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tombstone already exists' }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          }
        }
      } else {
        try {
          syncStore.put(keyHash, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          if (message.includes('tombstone')) {
            const entry = syncStore.get(keyHash);
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tombstone exists', type: 'tombstone', data: entry?.data }));
          } else if (message.includes('exceeds max size')) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          }
        }
      }
    });
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

// relay is set before any requests arrive (server listens after createRelay returns)
let relay!: RelayInstance;

relay = createRelay({
  port: PORT,
  keyStore: false, // Open access — Quicksave handles its own crypto-based authentication
  blobStore: false, // Sync store is handled via onHttpRequest hook

  channels: [
    {
      name: 'agent',
      onDuplicate: 'reject',
    },
    {
      // Key-based PWA: connects at /pwa/{encodedPublicKey}
      // Public keys are URL-encoded Base64 so we decode them in parseId
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
      console.log(`[CONNECT] ${peer.address} from ${peer.ip}`);
      if (peer.channel === 'agent') {
        // Notify key-based PWAs watching this agent that it came online
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
      console.log(`[DISCONNECT] ${peer.address}`);
      if (peer.channel === 'agent') {
        // Notify watchers that agent went offline
        const watchers = agentWatchers.get(peer.id) ?? new Set<string>();
        for (const pwaAddr of watchers) {
          const pwaPeer = registry.getByAddress(pwaAddr);
          if (pwaPeer && pwaPeer.ws.readyState === WebSocket.OPEN) {
            sendMessage(pwaPeer.ws, { type: 'agent-status', payload: { agentId: peer.id, online: false } });
          }
        }
      }
      if (peer.channel === 'pwa') {
        // Notify agents this PWA was watching, then clean up
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

      // Handle watch-agent subscription from key-based PWA
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

    onHttpRequest(req: IncomingMessage, res: ServerResponse, next: () => void) {
      // Override /stats to include syncStore stats
      if (req.url === '/stats') {
        const stats = relay.registry.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...stats, syncStore: syncStore.stats }));
        return;
      }

      // Handle /sync/* routes
      const syncMatch = req.url?.match(/^\/sync\/([a-zA-Z0-9_-]{8,64})(\/tombstone)?$/);
      if (syncMatch) {
        handleSyncRequest(req, res, syncMatch[1], !!syncMatch[2]);
        return;
      }

      next();
    },
  },
});

console.log(`Quicksave Signaling Server v${typeof VERSION !== 'undefined' ? VERSION : 'dev'}`);
console.log(`  Agent: ws://localhost:${PORT}/agent/{agentId}`);
console.log(`  PWA:   ws://localhost:${PORT}/pwa/{encodedPublicKey}`);
console.log(`  Sync:  http://localhost:${PORT}/sync/{keyHash}`);

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  relay.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  relay.close();
  process.exit(0);
});
