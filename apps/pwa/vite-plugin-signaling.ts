import type { Plugin, ViteDevServer } from 'vite';
import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const HEARTBEAT_INTERVAL = 30000;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX_CONNECTIONS = 10;
const RATE_LIMIT_MAX_MESSAGES = 100;

// Rate limiter
class RateLimiter {
  private connections: Map<string, { count: number; windowStart: number }> = new Map();
  private windowMs: number;
  private maxConnections: number;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(windowMs: number, maxConnections: number) {
    this.windowMs = windowMs;
    this.maxConnections = maxConnections;
    this.cleanupInterval = setInterval(() => this.cleanup(), windowMs);
  }

  checkConnection(ip: string): boolean {
    const now = Date.now();
    const entry = this.connections.get(ip);

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.connections.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.maxConnections) {
      return false;
    }

    entry.count++;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.connections) {
      if (now - entry.windowStart > this.windowMs) {
        this.connections.delete(ip);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

// Connection manager
class ConnectionManager {
  private agents: Map<string, WebSocket> = new Map();
  private pwas: Map<string, WebSocket> = new Map();

  get agentCount(): number {
    return this.agents.size;
  }

  get pwaCount(): number {
    return this.pwas.size;
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
}

// Utils
function parseUrl(url: string): { role: 'agent' | 'pwa'; agentId: string } | null {
  const match = url.match(/^\/(agent|pwa)\/([a-zA-Z0-9_-]+)$/);
  if (!match) return null;

  const [, role, agentId] = match;
  if (agentId.length < 8 || agentId.length > 64) return null;

  return { role: role as 'agent' | 'pwa', agentId };
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
  messageCount: number;
  lastMessageReset: number;
  ip: string;
}

export function signalingServerPlugin(): Plugin {
  let wss: WebSocketServer | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let connections: ConnectionManager | null = null;
  let rateLimiter: RateLimiter | null = null;

  return {
    name: 'vite-plugin-signaling',
    apply: 'serve',

    configureServer(viteServer: ViteDevServer) {
      connections = new ConnectionManager();
      rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_CONNECTIONS);

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

          if (!rateLimiter!.checkConnection(ip)) {
            sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many connections' } });
            ws.close(1008, 'Rate limited');
            return;
          }

          const parsed = parseUrl(req.url || '');
          if (!parsed) {
            sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_URL', message: 'Invalid connection URL' } });
            ws.close(1002, 'Invalid URL');
            return;
          }

          const { role, agentId } = parsed;
          extWs.role = role;
          extWs.agentId = agentId;
          extWs.isAlive = true;
          extWs.messageCount = 0;
          extWs.lastMessageReset = Date.now();

          console.log(`[signaling] ${role} connected for agent ${agentId}`);

          if (role === 'agent') {
            if (connections!.hasAgent(agentId)) {
              sendMessage(extWs, { type: 'error', payload: { code: 'AGENT_ID_IN_USE', message: 'Agent ID already connected' } });
              ws.close(1008, 'Agent ID in use');
              return;
            }

            connections!.addAgent(agentId, extWs);

            const waitingPwa = connections!.getPwa(agentId);
            if (waitingPwa) {
              console.log(`[signaling] Agent ${agentId} matched with waiting PWA`);
              sendMessage(extWs, { type: 'peer-connected' });
              sendMessage(waitingPwa, { type: 'peer-connected' });
            }
          } else {
            connections!.addPwa(agentId, extWs);

            const agent = connections!.getAgent(agentId);
            if (agent) {
              console.log(`[signaling] PWA matched with agent ${agentId}`);
              sendMessage(agent, { type: 'peer-connected' });
              sendMessage(extWs, { type: 'peer-connected' });
            } else {
              console.log(`[signaling] Agent ${agentId} is offline`);
              sendMessage(extWs, { type: 'peer-offline' });
            }
          }

          ws.on('message', (data: Buffer) => {
            const now = Date.now();
            if (now - extWs.lastMessageReset > RATE_LIMIT_WINDOW) {
              extWs.messageCount = 0;
              extWs.lastMessageReset = now;
            }
            extWs.messageCount++;

            if (extWs.messageCount > RATE_LIMIT_MAX_MESSAGES) {
              sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many messages' } });
              return;
            }

            const peer = role === 'agent'
              ? connections!.getPwa(agentId)
              : connections!.getAgent(agentId);

            if (peer && peer.readyState === WebSocket.OPEN) {
              peer.send(data);
            }
          });

          ws.on('pong', () => {
            extWs.isAlive = true;
          });

          ws.on('close', () => {
            console.log(`[signaling] ${role} disconnected for agent ${agentId}`);

            if (role === 'agent') {
              connections!.removeAgent(agentId);
              const pwa = connections!.getPwa(agentId);
              if (pwa) {
                sendMessage(pwa, { type: 'peer-offline' });
              }
            } else {
              connections!.removePwa(agentId);
              const agent = connections!.getAgent(agentId);
              if (agent) {
                sendMessage(agent, { type: 'bye' });
              }
            }
          });

          ws.on('error', (error) => {
            console.error(`[signaling] WebSocket error for ${role} ${agentId}:`, error.message);
          });
        });

        heartbeatInterval = setInterval(() => {
          wss!.clients.forEach((ws) => {
            const extWs = ws as ExtendedWebSocket;
            if (!extWs.isAlive) {
              console.log(`[signaling] Terminating dead connection: ${extWs.role} ${extWs.agentId}`);
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
      if (rateLimiter) {
        rateLimiter.destroy();
        rateLimiter = null;
      }
    },
  };
}
