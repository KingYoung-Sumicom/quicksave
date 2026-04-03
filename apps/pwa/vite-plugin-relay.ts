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

  return {
    name: 'vite-plugin-signaling',
    apply: 'serve',

    configureServer(viteServer: ViteDevServer) {
      connections = new ConnectionManager();
      syncStore = new SyncStore();

      // Add sync HTTP endpoints as Vite middleware
      viteServer.middlewares.use((req, res, next) => {
        const syncMatch = req.url?.match(/^\/sync\/([a-zA-Z0-9_-]{8,64})(\/tombstone)?$/);
        if (!syncMatch) return next();

        const keyHash = syncMatch[1];
        const isTombstoneRoute = !!syncMatch[2];

        // GET /sync/:keyHash
        if (req.method === 'GET' && !isTombstoneRoute) {
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

        // PUT /sync/:keyHash or PUT /sync/:keyHash/tombstone
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');

            if (isTombstoneRoute) {
              try {
                syncStore!.putTombstone(keyHash, body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown error';
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: message }));
              }
            } else {
              try {
                syncStore!.put(keyHash, body);
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
          return;
        }

        next();
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
