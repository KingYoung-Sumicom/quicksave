import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';

// Critical: Vitest mocks timers by default in some cases, which breaks WebSocket
vi.useRealTimers();

// Test signaling server implementation (simplified for testing)
async function createTestSignalingServer(port: number): Promise<{ server: HttpServer; wss: WebSocketServer; close: () => Promise<void> }> {
  const agents = new Map<string, WebSocket>();
  const pwas = new Map<string, WebSocket>();

  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const match = req.url?.match(/^\/(agent|pwa)\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
      ws.close(1002, 'Invalid URL');
      return;
    }

    const [, role, agentId] = match;

    if (role === 'agent') {
      agents.set(agentId, ws);

      const pwa = pwas.get(agentId);
      if (pwa && pwa.readyState === WebSocket.OPEN) {
        setImmediate(() => {
          ws.send(JSON.stringify({ type: 'peer-connected' }));
          pwa.send(JSON.stringify({ type: 'peer-connected' }));
        });
      }

      ws.on('message', (data: RawData) => {
        const p = pwas.get(agentId);
        if (p && p.readyState === WebSocket.OPEN) {
          setImmediate(() => p.send(data.toString()));
        }
      });

      ws.on('close', () => {
        agents.delete(agentId);
        const p = pwas.get(agentId);
        if (p && p.readyState === WebSocket.OPEN) {
          setImmediate(() => p.send(JSON.stringify({ type: 'peer-offline' })));
        }
      });
    } else {
      pwas.set(agentId, ws);

      const agent = agents.get(agentId);
      if (agent && agent.readyState === WebSocket.OPEN) {
        setImmediate(() => {
          agent.send(JSON.stringify({ type: 'peer-connected' }));
          ws.send(JSON.stringify({ type: 'peer-connected' }));
        });
      } else {
        setImmediate(() => {
          ws.send(JSON.stringify({ type: 'peer-offline' }));
        });
      }

      ws.on('message', (data: RawData) => {
        const a = agents.get(agentId);
        if (a && a.readyState === WebSocket.OPEN) {
          setImmediate(() => a.send(data.toString()));
        }
      });

      ws.on('close', () => {
        pwas.delete(agentId);
        const a = agents.get(agentId);
        if (a && a.readyState === WebSocket.OPEN) {
          setImmediate(() => a.send(JSON.stringify({ type: 'bye' })));
        }
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        wss,
        close: () => new Promise<void>((res) => {
          wss.clients.forEach((client) => client.close());
          wss.close(() => {
            server.close(() => res());
          });
        }),
      });
    });
  });
}

// Helper: create WebSocket with message listener set up BEFORE open
function createWebSocketWithListener(url: string): { ws: WebSocket; firstMessage: Promise<any>; waitForOpen: Promise<void> } {
  const ws = new WebSocket(url);

  const firstMessage = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for first message')), 5000);
    ws.once('message', (data: RawData) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });

  const waitForOpen = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { ws, firstMessage, waitForOpen };
}

// Helper to wait for a message
function waitForMessage(ws: WebSocket, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for message'));
    }, timeout);

    ws.once('message', (data: RawData) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// Helper to wait for close
function waitForClose(ws: WebSocket, timeout = 5000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1000 });
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for close'));
    }, timeout);

    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

// Collect all WebSockets to close after each test
let activeConnections: WebSocket[] = [];

function trackConnection(ws: WebSocket): WebSocket {
  activeConnections.push(ws);
  return ws;
}

describe('Signaling Server E2E', () => {
  let signalingServer: { server: HttpServer; wss: WebSocketServer; close: () => Promise<void> };
  const PORT = 18080;
  const BASE_URL = `ws://localhost:${PORT}`;

  beforeAll(async () => {
    signalingServer = await createTestSignalingServer(PORT);
  });

  afterAll(async () => {
    await signalingServer?.close();
  });

  afterEach(() => {
    activeConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });
    activeConnections = [];
  });

  describe('Connection Flow', () => {
    it('should connect agent successfully', async () => {
      const { ws, waitForOpen } = createWebSocketWithListener(`${BASE_URL}/agent/test-agent-1`);
      trackConnection(ws);
      await waitForOpen;
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should notify PWA when agent is offline', async () => {
      const { ws, firstMessage, waitForOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/nonexistent-agent-${Date.now()}`);
      trackConnection(ws);
      await waitForOpen;
      const message = await firstMessage;
      expect(message.type).toBe('peer-offline');
    });

    it('should notify both parties when PWA connects to online agent', async () => {
      const agentId = 'test-agent-connect-' + Date.now();

      // Agent connects first
      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      // Set up message listener BEFORE PWA connects
      const agentMsgPromise = waitForMessage(agentWs);

      // PWA connects
      const { ws: pwaWs, firstMessage: pwaMsgPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      // Both should receive peer-connected
      const [agentMsg, pwaMsg] = await Promise.all([agentMsgPromise, pwaMsgPromise]);

      expect(agentMsg.type).toBe('peer-connected');
      expect(pwaMsg.type).toBe('peer-connected');
    });

    it('should notify both parties when agent connects to waiting PWA', async () => {
      const agentId = 'test-agent-waiting-' + Date.now();

      // PWA connects first (will receive peer-offline)
      const { ws: pwaWs, firstMessage: pwaOfflinePromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;
      const offlineMsg = await pwaOfflinePromise;
      expect(offlineMsg.type).toBe('peer-offline');

      // Set up message listener BEFORE agent connects
      const pwaMsgPromise = waitForMessage(pwaWs);

      // Agent connects
      const { ws: agentWs, firstMessage: agentMsgPromise, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      // Both should receive peer-connected
      const [agentMsg, pwaMsg] = await Promise.all([agentMsgPromise, pwaMsgPromise]);

      expect(agentMsg.type).toBe('peer-connected');
      expect(pwaMsg.type).toBe('peer-connected');
    });
  });

  describe('Message Relay', () => {
    it('should relay message from agent to PWA', async () => {
      const agentId = 'relay-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      // Agent connects
      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      // Set up listener for agent before PWA connects
      const agentConnectPromise = waitForMessage(agentWs);

      // PWA connects
      const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      await Promise.all([agentConnectPromise, pwaConnectPromise]);

      // Set up listener BEFORE sending
      const receivePromise = waitForMessage(pwaWs);

      const testMessage = { type: 'offer', payload: { sdp: 'test-sdp' } };
      agentWs.send(JSON.stringify(testMessage));

      const received = await receivePromise;
      expect(received).toEqual(testMessage);
    });

    it('should relay message from PWA to agent', async () => {
      const agentId = 'relay-test-pwa-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      const agentConnectPromise = waitForMessage(agentWs);

      const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      await Promise.all([agentConnectPromise, pwaConnectPromise]);

      const receivePromise = waitForMessage(agentWs);

      const testMessage = { type: 'answer', payload: { sdp: 'test-answer' } };
      pwaWs.send(JSON.stringify(testMessage));

      const received = await receivePromise;
      expect(received).toEqual(testMessage);
    });

    it('should relay multiple messages in order', async () => {
      const agentId = 'relay-multi-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      const agentConnectPromise = waitForMessage(agentWs);

      const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      await Promise.all([agentConnectPromise, pwaConnectPromise]);

      const messages = [
        { type: 'ice-candidate', payload: { candidate: '1' } },
        { type: 'ice-candidate', payload: { candidate: '2' } },
        { type: 'ice-candidate', payload: { candidate: '3' } },
      ];

      const received: any[] = [];
      const collectMessages = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Collect timeout')), 5000);
        pwaWs.on('message', (data: RawData) => {
          received.push(JSON.parse(data.toString()));
          if (received.length === messages.length) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      for (const msg of messages) {
        agentWs.send(JSON.stringify(msg));
      }

      await collectMessages;
      expect(received).toEqual(messages);
    });
  });

  describe('Disconnection Handling', () => {
    it('should notify PWA when agent disconnects', async () => {
      const agentId = 'disconnect-test-' + Date.now();

      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      const agentConnectPromise = waitForMessage(agentWs);

      const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      await Promise.all([agentConnectPromise, pwaConnectPromise]);

      const disconnectPromise = waitForMessage(pwaWs);
      agentWs.close();

      const message = await disconnectPromise;
      expect(message.type).toBe('peer-offline');
    });

    it('should notify agent when PWA disconnects', async () => {
      const agentId = 'pwa-disconnect-test-' + Date.now();

      const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
      trackConnection(agentWs);
      await agentOpen;

      const agentConnectPromise = waitForMessage(agentWs);

      const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
      trackConnection(pwaWs);
      await pwaOpen;

      await Promise.all([agentConnectPromise, pwaConnectPromise]);

      const disconnectPromise = waitForMessage(agentWs);
      pwaWs.close();

      const message = await disconnectPromise;
      expect(message.type).toBe('bye');
    });
  });

  describe('Invalid Connections', () => {
    it('should close connection for invalid URL', async () => {
      const ws = new WebSocket(`${BASE_URL}/invalid/path`);
      trackConnection(ws);
      const result = await waitForClose(ws);
      expect(result.code).toBe(1002);
    });

    it('should close connection for missing agent ID', async () => {
      const ws = new WebSocket(`${BASE_URL}/agent/`);
      trackConnection(ws);
      const result = await waitForClose(ws);
      expect(result.code).toBe(1002);
    });
  });

  describe('Multiple Sessions', () => {
    it('should handle multiple independent agent-PWA pairs', async () => {
      const pairs: Array<{ agentId: string; agentWs: WebSocket; pwaWs: WebSocket }> = [];

      for (let i = 0; i < 3; i++) {
        const agentId = `multi-test-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const { ws: agentWs, waitForOpen: agentOpen } = createWebSocketWithListener(`${BASE_URL}/agent/${agentId}`);
        trackConnection(agentWs);
        await agentOpen;

        const agentConnectPromise = waitForMessage(agentWs);

        const { ws: pwaWs, firstMessage: pwaConnectPromise, waitForOpen: pwaOpen } = createWebSocketWithListener(`${BASE_URL}/pwa/${agentId}`);
        trackConnection(pwaWs);
        await pwaOpen;

        await Promise.all([agentConnectPromise, pwaConnectPromise]);

        pairs.push({ agentId, agentWs, pwaWs });
      }

      for (let i = 0; i < pairs.length; i++) {
        const { agentWs, pwaWs } = pairs[i];
        const receivePromise = waitForMessage(pwaWs);

        const testMessage = { type: 'test', index: i };
        agentWs.send(JSON.stringify(testMessage));

        const received = await receivePromise;
        expect(received.index).toBe(i);
      }
    });
  });
});
