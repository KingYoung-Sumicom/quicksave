// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Plugin, ViteDevServer } from 'vite';
import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const HEARTBEAT_INTERVAL = 30000;

// Connection manager
class ConnectionManager {
  private agents: Map<string, WebSocket> = new Map();
  private pwas: Map<string, WebSocket> = new Map();
  private pwasByKey: Map<string, WebSocket> = new Map();
  private agentWatchers: Map<string, Set<string>> = new Map();

  get agentCount(): number {
    return this.agents.size;
  }

  get pwaCount(): number {
    return this.pwas.size + this.pwasByKey.size;
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  getAgent(agentId: string): WebSocket | undefined {
    return this.agents.get(agentId);
  }

  getPwa(agentId: string): WebSocket | undefined {
    return this.pwas.get(agentId);
  }

  addAgent(agentId: string, ws: WebSocket): void {
    this.agents.set(agentId, ws);
  }

  addPwa(agentId: string, ws: WebSocket): void {
    this.pwas.set(agentId, ws);
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  removePwa(agentId: string): void {
    this.pwas.delete(agentId);
  }

  addPwaByKey(publicKey: string, ws: WebSocket): void {
    this.pwasByKey.set(publicKey, ws);
  }

  removePwaByKey(publicKey: string): void {
    this.pwasByKey.delete(publicKey);
  }

  getPwaByKey(publicKey: string): WebSocket | undefined {
    return this.pwasByKey.get(publicKey);
  }

  addAgentWatcher(agentId: string, pwaKey: string): void {
    let watchers = this.agentWatchers.get(agentId);
    if (!watchers) {
      watchers = new Set();
      this.agentWatchers.set(agentId, watchers);
    }
    watchers.add(pwaKey);
  }

  getAgentWatchers(agentId: string): Set<string> {
    return this.agentWatchers.get(agentId) || new Set();
  }

  removeAllWatchersForPwa(pwaKey: string): void {
    for (const [, watchers] of this.agentWatchers) {
      watchers.delete(pwaKey);
    }
  }

  /**
   * Look up a WebSocket by address string.
   * Address format: "agent:{id}" or "pwa:{id}"
   * For "pwa:{id}", checks pwasByKey first, then legacy pwas map.
   */
  getByAddress(address: string): WebSocket | undefined {
    const colonIdx = address.indexOf(':');
    if (colonIdx === -1) return undefined;
    const role = address.slice(0, colonIdx);
    const id = address.slice(colonIdx + 1);
    if (role === 'agent') return this.getAgent(id);
    if (role === 'pwa') return this.getPwaByKey(id) || this.getPwa(id);
    return undefined;
  }
}

// Utils
interface ParsedUrl {
  role: 'agent' | 'pwa';
  id: string;
  isPwaKey?: boolean;
}

function parseUrl(url: string): ParsedUrl | null {
  // /pwa/{publicKey} - URL-encoded base64 public key
  const pwaKeyMatch = url.match(/^\/pwa\/([a-zA-Z0-9_\-%.]+)$/);
  if (pwaKeyMatch) {
    const publicKey = decodeURIComponent(pwaKeyMatch[1]);
    if (publicKey.length >= 8) return { role: 'pwa', id: publicKey, isPwaKey: true };
    return null;
  }

  // /agent/{agentId}
  const match = url.match(/^\/(agent)\/([a-zA-Z0-9_-]+)$/);
  if (!match) return null;

  const [, role, agentId] = match;
  if (agentId.length < 8 || agentId.length > 64) return null;

  return { role: role as 'agent' | 'pwa', id: agentId };
}

function sendMessage(ws: WebSocket, message: { type: string; payload?: unknown }): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  role?: 'agent' | 'pwa';
  agentId?: string;
  pwaKey?: string;  // for key-based PWA connections (/pwa/key/{publicKey})
  ip: string;
}

// In-memory pair mailbox store for dev (mirrors apps/relay/src/pairStore.ts).
interface DevPairSlot {
  id: string;
  data: string;
  kind?: string;
  createdAt: number;
}
interface DevPairMailbox {
  slots: DevPairSlot[];
  expiresAt: number;
  listeners: Set<(slot: DevPairSlot) => void>;
}
class DevPairStore {
  private mailboxes = new Map<string, DevPairMailbox>();
  private readonly ttlMs = 5 * 60_000;
  private readonly maxSlots = 64;
  private readonly maxDataSize = 8192;
  private nextId = 1;

  postSlot(addr: string, input: { data: string; kind?: string }): DevPairSlot {
    if (input.data.length > this.maxDataSize) throw new Error('data too large');
    const now = Date.now();
    let mb = this.mailboxes.get(addr);
    if (!mb) {
      mb = { slots: [], expiresAt: now + this.ttlMs, listeners: new Set() };
      this.mailboxes.set(addr, mb);
    }
    if (mb.expiresAt < now + this.ttlMs) mb.expiresAt = now + this.ttlMs;
    if (mb.slots.length >= this.maxSlots) throw new Error('mailbox full');
    const slot: DevPairSlot = {
      id: `s-${this.nextId++}-${now}`,
      data: input.data,
      kind: input.kind,
      createdAt: now,
    };
    mb.slots.push(slot);
    for (const fn of mb.listeners) {
      try { fn(slot); } catch { /* ignore */ }
    }
    return slot;
  }
  getSlots(addr: string): DevPairSlot[] {
    const mb = this.mailboxes.get(addr);
    if (!mb) return [];
    if (mb.expiresAt <= Date.now()) { this.mailboxes.delete(addr); return []; }
    return mb.slots.slice();
  }
  deleteMailbox(addr: string): void {
    const mb = this.mailboxes.get(addr);
    if (mb) { mb.listeners.clear(); mb.slots = []; }
    this.mailboxes.delete(addr);
  }
  subscribe(addr: string, onSlot: (s: DevPairSlot) => void): () => void {
    let mb = this.mailboxes.get(addr);
    if (!mb) {
      mb = { slots: [], expiresAt: Date.now() + this.ttlMs, listeners: new Set() };
      this.mailboxes.set(addr, mb);
    }
    mb.listeners.add(onSlot);
    return () => {
      const cur = this.mailboxes.get(addr);
      if (cur) cur.listeners.delete(onSlot);
    };
  }
}

// In-memory sync store for dev
class SyncStore {
  private entries = new Map<string, { data: string; isTombstone: boolean }>();

  get(keyHash: string): { type: 'blob' | 'tombstone'; data: string } | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    return { type: entry.isTombstone ? 'tombstone' : 'blob', data: entry.data };
  }

  put(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) throw new Error('Cannot write to key with tombstone');
    if (data.length > 8192) throw new Error('Blob exceeds max size (8192 bytes)');
    this.entries.set(keyHash, { data, isTombstone: false });
  }

  putTombstone(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) throw new Error('Tombstone already exists for this key');
    this.entries.set(keyHash, { data, isTombstone: true });
  }
}

export function signalingServerPlugin(): Plugin {
  let wss: WebSocketServer | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let connections: ConnectionManager | null = null;
  let syncStore: SyncStore | null = null;
  let pairStore: DevPairStore | null = null;

  return {
    name: 'vite-plugin-signaling',
    apply: 'serve',

    configureServer(viteServer: ViteDevServer) {
      connections = new ConnectionManager();
      syncStore = new SyncStore();
      pairStore = new DevPairStore();

      // Add pair-request HTTP endpoints as Vite middleware
      viteServer.middlewares.use((req, res, next) => {
        const pairMatch = req.url?.match(
          /^\/pair-requests\/([A-Za-z0-9_-]{8,128})(\/subscribe)?(?:\?.*)?$/,
        );
        if (!pairMatch) return next();
        const addr = pairMatch[1];
        const subscribe = !!pairMatch[2];

        if (subscribe && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          for (const slot of pairStore!.getSlots(addr)) {
            res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
          }
          const unsub = pairStore!.subscribe(addr, (slot) => {
            res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
          });
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          const teardown = () => {
            clearInterval(ping);
            unsub();
            try { res.end(); } catch { /* ignore */ }
          };
          req.on('close', teardown);
          req.on('error', teardown);
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ slots: pairStore!.getSlots(addr) }));
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf-8');
              const parsed = JSON.parse(body) as { data?: unknown; kind?: unknown };
              if (typeof parsed.data !== 'string' || parsed.data.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'data required' }));
                return;
              }
              const kind = typeof parsed.kind === 'string' ? parsed.kind : undefined;
              const slot = pairStore!.postSlot(addr, { data: parsed.data, kind });
              res.writeHead(201, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ id: slot.id }));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const status = msg.includes('full') ? 409 : msg.includes('too large') ? 413 : 400;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: msg }));
            }
          });
          return;
        }
        if (req.method === 'DELETE') {
          pairStore!.deleteMailbox(addr);
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(405);
        res.end('Method Not Allowed');
      });

      // Add sync HTTP endpoints as Vite middleware
      viteServer.middlewares.use((req, res, next) => {
        const syncMatch = req.url?.match(
          /^\/sync\/([a-zA-Z0-9_-]{8,64})(\/tombstone|\/lock)?$/,
        );
        if (!syncMatch) return next();

        const keyHash = syncMatch[1];
        const suffix = syncMatch[2];
        const subpath: 'blob' | 'tombstone' | 'lock' =
          suffix === '/tombstone' ? 'tombstone' : suffix === '/lock' ? 'lock' : 'blob';

        // GET /sync/:keyHash
        if (req.method === 'GET' && subpath === 'blob') {
          const entry = syncStore!.get(keyHash);
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

        const isWrite =
          (req.method === 'PUT' && (subpath === 'blob' || subpath === 'tombstone')) ||
          (req.method === 'DELETE' && subpath === 'lock');
        if (!isWrite) {
          res.writeHead(405);
          res.end('Method Not Allowed');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          // Dev server accepts SignedSyncEnvelope bodies but skips Ed25519
          // verification — nothing else talks to it. We only need to pull
          // `ciphertext` out for the write actions.
          let envelope: { action?: string; ciphertext?: string; sigPubkey?: string } | null = null;
          try {
            envelope = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON' }));
            return;
          }
          if (!envelope || typeof envelope !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid envelope' }));
            return;
          }

          if (subpath === 'lock') {
            // Dev store has no mutex — always report released=false.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ released: false }));
            return;
          }

          const ciphertext = envelope.ciphertext;
          if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ciphertext required' }));
            return;
          }

          if (subpath === 'tombstone') {
            try {
              syncStore!.putTombstone(keyHash, ciphertext);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: message }));
            }
          } else {
            try {
              syncStore!.put(keyHash, ciphertext);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              if (message.includes('tombstone')) {
                const entry = syncStore!.get(keyHash);
                res.writeHead(410, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Tombstone exists', type: 'tombstone', data: entry?.data }));
              } else if (message.includes('max size')) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: message }));
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: message }));
              }
            }
          }
        });
      });

      // Wait for httpServer to be available
      viteServer.httpServer?.once('listening', () => {
        // Create WebSocket server with noServer mode for manual upgrade handling
        wss = new WebSocketServer({ noServer: true });

        // Handle upgrade requests for signaling paths only
        viteServer.httpServer!.on('upgrade', (request, socket, head) => {
          const url = request.url || '';

          // Only handle /agent/* and /pwa/* paths
          if (url.startsWith('/agent/') || url.startsWith('/pwa/')) {
            wss!.handleUpgrade(request, socket, head, (ws) => {
              wss!.emit('connection', ws, request);
            });
          }
          // Let Vite's HMR WebSocket handle other upgrade requests
        });

        // Handle WebSocket connections
        wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          const extWs = ws as ExtendedWebSocket;
          const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim()
            || req.socket.remoteAddress
            || 'unknown';
          extWs.ip = ip;

          // No connection rate limiting — this plugin only runs in local dev

          const parsed = parseUrl(req.url || '');
          if (!parsed) {
            sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_URL', message: 'Invalid connection URL' } });
            ws.close(1002, 'Invalid URL');
            return;
          }

          const { role, id } = parsed;
          extWs.role = role;
          extWs.isAlive = true;

          if (parsed.isPwaKey) {
            // New: PWA connecting by public key
            extWs.pwaKey = id;
            connections!.addPwaByKey(id, extWs);
            console.log(`[signaling] pwa (key) connected with key ${id}`);
            // Key-based PWAs use routed messages, no implicit agent matching
          } else if (role === 'agent') {
            extWs.agentId = id;
            console.log(`[signaling] ${role} connected for agent ${id}`);

            if (connections!.hasAgent(id)) {
              sendMessage(extWs, { type: 'error', payload: { code: 'AGENT_ID_IN_USE', message: 'Agent ID already connected' } });
              ws.close(1008, 'Agent ID in use');
              return;
            }

            connections!.addAgent(id, extWs);

            // Notify key-based PWAs watching this agent
            const watchers = connections!.getAgentWatchers(id);
            for (const pwaKey of watchers) {
              const pwa = connections!.getPwaByKey(pwaKey);
              if (pwa && pwa.readyState === WebSocket.OPEN) {
                sendMessage(pwa, { type: 'agent-status', payload: { agentId: id, online: true } });
              }
            }

            const waitingPwa = connections!.getPwa(id);
            if (waitingPwa) {
              console.log(`[signaling] Agent ${id} matched with waiting PWA`);
              sendMessage(extWs, { type: 'peer-connected' });
              sendMessage(waitingPwa, { type: 'peer-connected' });
            }
          } else {
            // Legacy PWA connecting by agentId
            extWs.agentId = id;
            connections!.addPwa(id, extWs);
            console.log(`[signaling] ${role} connected for agent ${id}`);

            const agent = connections!.getAgent(id);
            if (agent) {
              console.log(`[signaling] PWA matched with agent ${id}`);
              sendMessage(agent, { type: 'peer-connected' });
              sendMessage(extWs, { type: 'peer-connected' });
            } else {
              console.log(`[signaling] Agent ${id} is offline`);
              sendMessage(extWs, { type: 'peer-offline' });
            }
          }

          // Handle incoming messages - routed or legacy relay
          ws.on('message', (data: Buffer) => {
            // Try routed message handling first
            try {
              const msgStr = data.toString();
              const msg = JSON.parse(msgStr);

              // Handle watch-agent requests from key-based PWAs
              if (msg.type === 'watch-agent' && msg.agentId && extWs.pwaKey) {
                connections!.addAgentWatcher(msg.agentId, extWs.pwaKey);
                const isOnline = connections!.hasAgent(msg.agentId);
                sendMessage(extWs, { type: 'agent-status', payload: { agentId: msg.agentId, online: isOnline } });
                return;
              }

              if (msg.from && msg.to) {
                // Validate `from` matches sender identity
                let expectedFrom: string | undefined;
                if (extWs.role === 'agent' && extWs.agentId) {
                  expectedFrom = `agent:${extWs.agentId}`;
                } else if (extWs.pwaKey) {
                  expectedFrom = `pwa:${extWs.pwaKey}`;
                } else if (extWs.role === 'pwa' && extWs.agentId) {
                  expectedFrom = `pwa:${extWs.agentId}`;
                }

                if (expectedFrom && msg.from !== expectedFrom) {
                  sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_FROM', message: 'From field does not match sender identity' } });
                  return;
                }

                // Route to target
                const target = connections!.getByAddress(msg.to);
                if (target && target.readyState === WebSocket.OPEN) {
                  target.send(data);
                }
                return; // Don't fall through to legacy relay
              }
            } catch {
              // Not valid JSON or no routing fields - fall through to legacy relay
            }

            // Legacy relay: forward to peer without inspection
            if (extWs.agentId) {
              const peer = extWs.role === 'agent'
                ? connections!.getPwa(extWs.agentId)
                : connections!.getAgent(extWs.agentId);

              if (peer && peer.readyState === WebSocket.OPEN) {
                peer.send(data);
              }
            }
          });

          ws.on('pong', () => {
            extWs.isAlive = true;
          });

          ws.on('close', () => {
            if (extWs.pwaKey) {
              console.log(`[signaling] pwa (key) disconnected with key ${extWs.pwaKey}`);
              connections!.removeAllWatchersForPwa(extWs.pwaKey);
              connections!.removePwaByKey(extWs.pwaKey);
            } else if (extWs.role === 'agent' && extWs.agentId) {
              console.log(`[signaling] ${extWs.role} disconnected for agent ${extWs.agentId}`);
              // Notify key-based PWA watchers that agent went offline
              const agentWatchers = connections!.getAgentWatchers(extWs.agentId);
              for (const pwaKey of agentWatchers) {
                const watcherPwa = connections!.getPwaByKey(pwaKey);
                if (watcherPwa && watcherPwa.readyState === WebSocket.OPEN) {
                  sendMessage(watcherPwa, { type: 'agent-status', payload: { agentId: extWs.agentId, online: false } });
                }
              }
              connections!.removeAgent(extWs.agentId);
              const pwa = connections!.getPwa(extWs.agentId);
              if (pwa) {
                sendMessage(pwa, { type: 'peer-offline' });
              }
            } else if (extWs.role === 'pwa' && extWs.agentId) {
              console.log(`[signaling] ${extWs.role} disconnected for agent ${extWs.agentId}`);
              connections!.removePwa(extWs.agentId);
              const agent = connections!.getAgent(extWs.agentId);
              if (agent) {
                sendMessage(agent, { type: 'bye' });
              }
            }
          });

          ws.on('error', (error) => {
            console.error(`[signaling] WebSocket error for ${extWs.role} ${extWs.agentId || extWs.pwaKey}:`, error.message);
          });
        });

        heartbeatInterval = setInterval(() => {
          wss!.clients.forEach((ws) => {
            const extWs = ws as ExtendedWebSocket;
            if (!extWs.isAlive) {
              console.log(`[signaling] Terminating dead connection: ${extWs.role} ${extWs.agentId || extWs.pwaKey}`);
              return ws.terminate();
            }
            extWs.isAlive = false;
            ws.ping();
          });
        }, HEARTBEAT_INTERVAL);

        console.log(`[signaling] Server running on same port as Vite`);
      });
    },

    buildEnd() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (wss) {
        wss.close();
        wss = null;
      }
    },
  };
}
