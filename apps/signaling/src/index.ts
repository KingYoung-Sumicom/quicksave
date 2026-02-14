import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RateLimiter } from './rateLimiter.js';
import { ConnectionManager } from './connections.js';
import { parseUrl, sendMessage } from './utils.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_CONNECTIONS = 10; // Max new connections per IP per minute
const RATE_LIMIT_MAX_MESSAGES = 100; // Max messages per connection per minute

const connections = new ConnectionManager();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_CONNECTIONS);

const server = createServer((req, res) => {
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
    res.end(JSON.stringify(connections.getStats()));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });

// Extended WebSocket with metadata
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  role?: 'agent' | 'pwa';
  agentId?: string;
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

  const { role, agentId } = parsed;
  extWs.role = role;
  extWs.agentId = agentId;
  extWs.isAlive = true;
  extWs.messageCount = 0;
  extWs.lastMessageReset = Date.now();

  console.log(`[CONNECT] ${role} connected for agent ${agentId} from ${ip}`);

  if (role === 'agent') {
    // Check if agent ID is already in use
    if (connections.hasAgent(agentId)) {
      console.log(`[ERROR] Agent ID ${agentId} already in use`);
      sendMessage(extWs, { type: 'error', payload: { code: 'AGENT_ID_IN_USE', message: 'Agent ID already connected' } });
      ws.close(1008, 'Agent ID in use');
      return;
    }

    connections.addAgent(agentId, extWs);

    // Check if there's a waiting PWA
    const waitingPwa = connections.getPwa(agentId);
    if (waitingPwa) {
      console.log(`[MATCH] Agent ${agentId} matched with waiting PWA`);
      sendMessage(extWs, { type: 'peer-connected' });
      sendMessage(waitingPwa, { type: 'peer-connected' });
    }
  } else {
    // PWA connecting
    connections.addPwa(agentId, extWs);

    // Check if agent is online
    const agent = connections.getAgent(agentId);
    if (agent) {
      console.log(`[MATCH] PWA matched with agent ${agentId}`);
      sendMessage(agent, { type: 'peer-connected' });
      sendMessage(extWs, { type: 'peer-connected' });
    } else {
      console.log(`[OFFLINE] Agent ${agentId} is offline`);
      sendMessage(extWs, { type: 'peer-offline' });
    }
  }

  // Handle incoming messages - just relay to peer
  ws.on('message', (data: Buffer) => {
    // Rate limit messages
    const now = Date.now();
    if (now - extWs.lastMessageReset > RATE_LIMIT_WINDOW) {
      extWs.messageCount = 0;
      extWs.lastMessageReset = now;
    }
    extWs.messageCount++;

    if (extWs.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      console.log(`[RATE_LIMIT] Message rate exceeded for ${role} ${agentId}`);
      sendMessage(extWs, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many messages' } });
      return;
    }

    // Forward to peer without inspection
    const peer = role === 'agent'
      ? connections.getPwa(agentId)
      : connections.getAgent(agentId);

    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(data);
    }
  });

  // Handle pong for heartbeat
  ws.on('pong', () => {
    extWs.isAlive = true;
  });

  // Handle close
  ws.on('close', () => {
    console.log(`[DISCONNECT] ${role} disconnected for agent ${agentId}`);

    if (role === 'agent') {
      connections.removeAgent(agentId);
      // Notify PWA that agent went offline
      const pwa = connections.getPwa(agentId);
      if (pwa) {
        sendMessage(pwa, { type: 'peer-offline' });
      }
    } else {
      connections.removePwa(agentId);
      // Optionally notify agent that PWA disconnected
      const agent = connections.getAgent(agentId);
      if (agent) {
        sendMessage(agent, { type: 'bye' });
      }
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`[ERROR] WebSocket error for ${role} ${agentId}:`, error.message);
  });
});

// Heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const extWs = ws as ExtendedWebSocket;
    if (!extWs.isAlive) {
      console.log(`[HEARTBEAT] Terminating dead connection: ${extWs.role} ${extWs.agentId}`);
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
  console.log('Quicksave Signaling Server v0.1.0');
  console.log('='.repeat(50));
  console.log(`Listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('WebSocket Endpoints:');
  console.log(`  ws://localhost:${PORT}/agent/{agentId}  - Desktop Agent`);
  console.log(`  ws://localhost:${PORT}/pwa/{agentId}    - PWA Client`);
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
