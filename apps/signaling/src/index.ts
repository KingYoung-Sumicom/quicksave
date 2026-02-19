import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RateLimiter } from './rateLimiter.js';
import { ConnectionManager } from './connections.js';
import { SyncStore } from './syncStore.js';
import { parseUrl, sendMessage } from './utils.js';

// Injected by esbuild at build time from package.json
declare const VERSION: string;

const PORT = parseInt(process.env.PORT || '8080', 10);
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_CONNECTIONS = 10; // Max new connections per IP per minute
const RATE_LIMIT_MAX_MESSAGES = 100; // Max messages per connection per minute

const connections = new ConnectionManager();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_CONNECTIONS);
const syncStore = new SyncStore();

// CORS headers for cross-origin requests from PWA
const setCorsHeaders = (res: import('http').ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const server = createServer((req, res) => {
  // Set CORS headers on all responses
  setCorsHeaders(res);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connections: {
        agents: connections.agentCount,
        pwas: connections.pwaCount,
      },
      uptime: process.uptime(),
    }));
    return;
  }

  // Stats endpoint (protected in production)
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...connections.getStats(),
      syncStore: syncStore.stats,
    }));
    return;
  }

  // Sync endpoints
  const syncMatch = req.url?.match(/^\/sync\/([a-zA-Z0-9_-]{8,64})(\/tombstone)?$/);
  if (syncMatch) {
    const keyHash = syncMatch[1];
    const isTombstoneRoute = !!syncMatch[2];

    // GET /sync/:keyHash
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

    // PUT /sync/:keyHash or PUT /sync/:keyHash/tombstone
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');

        if (isTombstoneRoute) {
          // PUT /sync/:keyHash/tombstone
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
          // PUT /sync/:keyHash
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
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });

// Extended WebSocket with metadata
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  role?: 'agent' | 'pwa';
  agentId?: string;   // for agents and legacy PWAs
  pwaKey?: string;     // for new PWA connections by public key
  messageCount: number;
  lastMessageReset: number;
  ip: string;
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const extWs = ws as ExtendedWebSocket;

  // Get client IP
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
  extWs.ip = ip;

  // Rate limit new connections
  if (!rateLimiter.checkConnection(ip)) {
    console.log(`[RATE_LIMIT] Connection rejected from ${ip}`);
    sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many connections' } });
    ws.close(1008, 'Rate limited');
    return;
  }

  // Parse URL to get role and agent ID
  const parsed = parseUrl(req.url || '');
  if (!parsed) {
    console.log(`[ERROR] Invalid URL: ${req.url}`);
    sendMessage(extWs, { type: 'error', payload: { code: 'INVALID_URL', message: 'Invalid connection URL' } });
    ws.close(1002, 'Invalid URL');
    return;
  }

  const { role, id } = parsed;
  extWs.role = role;
  extWs.isAlive = true;
  extWs.messageCount = 0;
  extWs.lastMessageReset = Date.now();

  if (parsed.isPwaKey) {
    // New: PWA connecting by public key
    // Close existing connection with the same key (e.g., duplicate tab)
    const existing = connections.getPwaByKey(id);
    if (existing && existing.readyState === WebSocket.OPEN) {
      console.log(`[REPLACE] Closing old pwa (key) connection for key ${id}`);
      sendMessage(existing, { type: 'error', payload: { code: 'REPLACED', message: 'Connected from another tab or device' } });
      existing.close(1000, 'Replaced by new connection');
    }

    extWs.pwaKey = id;
    connections.addPwaByKey(id, extWs);
    console.log(`[CONNECT] pwa (key) connected with key ${id} from ${ip}`);
    // Key-based PWAs use routed messages, no implicit agent matching
  } else if (role === 'agent') {
    extWs.agentId = id;
    console.log(`[CONNECT] ${role} connected for agent ${id} from ${ip}`);

    // Check if agent ID is already in use
    if (connections.hasAgent(id)) {
      console.log(`[ERROR] Agent ID ${id} already in use`);
      sendMessage(extWs, { type: 'error', payload: { code: 'AGENT_ID_IN_USE', message: 'Agent ID already connected' } });
      ws.close(1008, 'Agent ID in use');
      return;
    }

    connections.addAgent(id, extWs);

    // Notify key-based PWAs watching this agent
    const watchers = connections.getAgentWatchers(id);
    for (const pwaKey of watchers) {
      const pwa = connections.getPwaByKey(pwaKey);
      if (pwa && pwa.readyState === WebSocket.OPEN) {
        sendMessage(pwa, { type: 'agent-status', payload: { agentId: id, online: true } });
      }
    }

    // Check if there's a waiting PWA
    const waitingPwa = connections.getPwa(id);
    if (waitingPwa) {
      console.log(`[MATCH] Agent ${id} matched with waiting PWA`);
      sendMessage(extWs, { type: 'peer-connected' });
      sendMessage(waitingPwa, { type: 'peer-connected' });
    }
  } else {
    // Legacy PWA connecting
    extWs.agentId = id;
    connections.addPwa(id, extWs);
    console.log(`[CONNECT] ${role} connected for agent ${id} from ${ip}`);

    // Check if agent is online
    const agent = connections.getAgent(id);
    if (agent) {
      console.log(`[MATCH] PWA matched with agent ${id}`);
      sendMessage(agent, { type: 'peer-connected' });
      sendMessage(extWs, { type: 'peer-connected' });
    } else {
      console.log(`[OFFLINE] Agent ${id} is offline`);
      sendMessage(extWs, { type: 'peer-offline' });
    }
  }

  // Handle incoming messages - routed or legacy relay
  ws.on('message', (data: Buffer) => {
    // Rate limit messages
    const now = Date.now();
    if (now - extWs.lastMessageReset > RATE_LIMIT_WINDOW) {
      extWs.messageCount = 0;
      extWs.lastMessageReset = now;
    }
    extWs.messageCount++;

    if (extWs.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      console.log(`[RATE_LIMIT] Message rate exceeded for ${extWs.role} ${extWs.agentId || extWs.pwaKey}`);
      sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many messages' } });
      return;
    }

    // Try routed message handling first
    try {
      const msgStr = data.toString();
      const msg = JSON.parse(msgStr);

      // Handle watch-agent requests from key-based PWAs
      if (msg.type === 'watch-agent' && msg.agentId && extWs.pwaKey) {
        connections.addAgentWatcher(msg.agentId, extWs.pwaKey);
        const isOnline = connections.hasAgent(msg.agentId);
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
        const target = connections.getByAddress(msg.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(data);
          connections.incrementMessagesRelayed();
        }
        return; // Don't fall through to legacy relay
      }
    } catch {
      // Not valid JSON or no routing fields — fall through to legacy relay
    }

    // Legacy relay: forward to peer without inspection
    if (extWs.agentId) {
      const peer = extWs.role === 'agent'
        ? connections.getPwa(extWs.agentId)
        : connections.getAgent(extWs.agentId);

      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(data);
      }
    }
  });

  // Handle pong for heartbeat
  ws.on('pong', () => {
    extWs.isAlive = true;
  });

  // Handle close
  ws.on('close', () => {
    if (extWs.pwaKey) {
      console.log(`[DISCONNECT] pwa (key) disconnected with key ${extWs.pwaKey}`);
      // Notify agents that this PWA was communicating with
      const watchedAgents = connections.getWatchedAgents(extWs.pwaKey);
      for (const agentId of watchedAgents) {
        const agent = connections.getAgent(agentId);
        if (agent && agent.readyState === WebSocket.OPEN) {
          sendMessage(agent, { type: 'pwa-bye', payload: { pwaAddress: `pwa:${extWs.pwaKey}` } });
        }
      }
      connections.removeAllWatchersForPwa(extWs.pwaKey);
      connections.removePwaByKey(extWs.pwaKey);
    } else if (extWs.role === 'agent' && extWs.agentId) {
      console.log(`[DISCONNECT] ${extWs.role} disconnected for agent ${extWs.agentId}`);
      // Notify key-based PWA watchers that agent went offline
      const agentWatchers = connections.getAgentWatchers(extWs.agentId);
      for (const pwaKey of agentWatchers) {
        const watcherPwa = connections.getPwaByKey(pwaKey);
        if (watcherPwa && watcherPwa.readyState === WebSocket.OPEN) {
          sendMessage(watcherPwa, { type: 'agent-status', payload: { agentId: extWs.agentId, online: false } });
        }
      }
      connections.removeAgent(extWs.agentId);
      // Notify legacy PWA that agent went offline
      const pwa = connections.getPwa(extWs.agentId);
      if (pwa) {
        sendMessage(pwa, { type: 'peer-offline' });
      }
    } else if (extWs.role === 'pwa' && extWs.agentId) {
      console.log(`[DISCONNECT] ${extWs.role} disconnected for agent ${extWs.agentId}`);
      connections.removePwa(extWs.agentId);
      // Optionally notify agent that PWA disconnected
      const agent = connections.getAgent(extWs.agentId);
      if (agent) {
        sendMessage(agent, { type: 'bye' });
      }
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`[ERROR] WebSocket error for ${extWs.role} ${extWs.agentId || extWs.pwaKey}:`, error.message);
  });
});

// Heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const extWs = ws as ExtendedWebSocket;
    if (!extWs.isAlive) {
      console.log(`[HEARTBEAT] Terminating dead connection: ${extWs.role} ${extWs.agentId || extWs.pwaKey}`);
      return ws.terminate();
    }
    extWs.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// Cleanup on server close
wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start server
server.listen(PORT, () => {
  console.log(`Quicksave Signaling Server v${VERSION}`);
  console.log('='.repeat(50));
  console.log(`Listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('WebSocket Endpoints:');
  console.log(`  ws://localhost:${PORT}/agent/{agentId}       - Desktop Agent`);
  console.log(`  ws://localhost:${PORT}/pwa/{agentId}         - PWA Client (legacy)`);
  console.log(`  ws://localhost:${PORT}/pwa/key/{publicKey}   - PWA Client (key-based)`);
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  wss.close();
  server.close();
  process.exit(0);
});
