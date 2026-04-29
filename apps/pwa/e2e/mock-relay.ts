/**
 * Mock relay server for Playwright E2E tests.
 *
 * Simulates the signaling relay from the agent's perspective:
 * - Accepts PWA WebSocket connections at /pwa/:connectionId
 * - Handles watch-agent → agent-status: online
 * - Performs V2 key exchange using real tweetnacl crypto
 * - Encrypts/decrypts messages with the negotiated session DEK
 * - Responds to handshake, claude:get-cards, etc.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { gzipSync, gunzipSync } from 'zlib';
import {
  generateKeyPair,
  encodeBase64,
  decryptDEK,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
} from '@sumicom/quicksave-shared';
import type {
  Message,
  HandshakeAckPayload,
  ClaudeSessionSummary,
  KeyPair,
} from '@sumicom/quicksave-shared';
import type {
  Card,
  CardHistoryResponse,
  CardEvent,
  CardStreamEnd,
} from '@sumicom/quicksave-shared';

// Gzip compress
function compress(data: string): string {
  const buf = gzipSync(Buffer.from(data, 'utf-8'));
  return buf.toString('base64');
}

// Gzip decompress
function decompress(base64: string): string {
  const buf = gunzipSync(Buffer.from(base64, 'base64'));
  return buf.toString('utf-8');
}

// ── Types ─────────────────────────────────────────────────────────────────

interface RoutedEnvelope {
  from: string;
  to: string;
  payload: string;
}

interface PeerState {
  ws: WebSocket;
  connectionId: string;
  agentId: string | null;
  sessionDEK: Uint8Array | null;
}

export interface MockRelayOptions {
  port?: number;
  /** Agent ID that the mock impersonates. */
  agentId?: string;
  /** Repository path returned in handshake:ack. */
  repoPath?: string;
  /** Sessions state used by the mock (returned via /sessions/history snap when wired). */
  sessions?: ClaudeSessionSummary[];
  /** Cards to return for claude:get-cards. */
  cards?: Card[];
  /** If provided, these card events will be emitted after a session starts. */
  cardEventsOnStart?: CardEvent[];
}

export class MockRelay {
  private server: http.Server;
  private wss: WebSocketServer;
  private port: number;
  private agentKeyPair: KeyPair;
  private agentId: string;
  private repoPath: string;
  private sessions: ClaudeSessionSummary[];
  private cards: Card[];
  private cardEventsOnStart: CardEvent[];
  private peers: Map<string, PeerState> = new Map();

  /** All raw messages received from the PWA (for assertions). */
  public receivedMessages: Message[] = [];

  constructor(options: MockRelayOptions = {}) {
    this.port = options.port ?? 4999;
    this.agentId = options.agentId ?? 'mock-agent-001';
    this.repoPath = options.repoPath ?? '/home/user/project';
    this.sessions = options.sessions ?? [];
    this.cards = options.cards ?? [];
    this.cardEventsOnStart = options.cardEventsOnStart ?? [];
    this.agentKeyPair = generateKeyPair();

    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const match = url.pathname.match(/^\/pwa\/(.+)$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const connectionId = decodeURIComponent(match[1]);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, connectionId);
      });
    });
  }

  /** Base64-encoded agent public key (for pairing/QR code). */
  get publicKey(): string {
    return encodeBase64(this.agentKeyPair.publicKey);
  }

  get url(): string {
    return `ws://localhost:${this.port}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => resolve());
      this.server.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const peer of this.peers.values()) {
      peer.ws.terminate();
    }
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.peers.clear();
    this.receivedMessages = [];
    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve());
      });
      // Force resolve after 2s to avoid hanging teardown
      setTimeout(resolve, 2000);
    });
  }

  // ── Connection handling ─────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, connectionId: string): void {
    const peer: PeerState = {
      ws,
      connectionId,
      agentId: null,
      sessionDEK: null,
    };
    this.peers.set(connectionId, peer);

    ws.on('message', async (data) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);

        // Direct signaling message (watch-agent)
        if (parsed.type === 'watch-agent') {
          peer.agentId = parsed.agentId;
          // Respond with agent online
          ws.send(JSON.stringify({
            type: 'agent-status',
            payload: { agentId: parsed.agentId, online: true },
          }));
          return;
        }

        // Routed envelope
        if (parsed.from && parsed.to && 'payload' in parsed) {
          await this.handleRoutedMessage(peer, parsed as RoutedEnvelope);
          return;
        }
      } catch (err) {
        console.error('[mock-relay] Error handling message:', err);
      }
    });

    ws.on('close', () => {
      this.peers.delete(connectionId);
    });
  }

  private async handleRoutedMessage(peer: PeerState, envelope: RoutedEnvelope): Promise<void> {
    const { payload } = envelope;

    // Before key exchange is complete: payload is plaintext JSON
    if (!peer.sessionDEK) {
      try {
        const msg = JSON.parse(payload);
        if (msg.type === 'key-exchange' && msg.version === 2) {
          // Decrypt the session DEK
          const dek = decryptDEK(msg.encryptedDEK, this.agentKeyPair.secretKey);
          peer.sessionDEK = dek;

          // Send key-exchange-ack
          const ack = JSON.stringify({ type: 'key-exchange-ack', version: 2 });
          this.sendRouted(peer, ack);
          return;
        }
      } catch {
        // Not a key exchange message
      }
      return;
    }

    // After key exchange: payload is encrypted(compressed(JSON))
    try {
      const decrypted = decryptWithSharedSecret(payload, peer.sessionDEK);
      const decompressed = decompress(decrypted);
      const message = JSON.parse(decompressed) as Message;
      this.receivedMessages.push(message);

      await this.handleAppMessage(peer, message);
    } catch (err) {
      console.error('[mock-relay] Failed to decrypt/decompress message:', err);
    }
  }

  // ── Application-level message handling ──────────────────────────────────

  private async handleAppMessage(peer: PeerState, message: Message): Promise<void> {
    switch (message.type) {
      case 'handshake': {
        const ackPayload: HandshakeAckPayload = {
          success: true,
          agentVersion: '0.6.3-mock',
          repoPath: this.repoPath,
          availableRepos: [{ path: this.repoPath, name: 'project' }],
          availableCodingPaths: [{ path: this.repoPath, name: 'project' }],
          preferences: { model: 'claude-sonnet-4-6' },
        };
        await this.sendEncrypted(peer, {
          id: `ack-${message.id}`,
          type: 'handshake:ack',
          payload: ackPayload,
          timestamp: Date.now(),
        });
        break;
      }

      case 'claude:get-cards': {
        const cardResponse: CardHistoryResponse = {
          cards: this.cards,
          total: this.cards.length,
          hasMore: false,
        };
        await this.sendEncrypted(peer, {
          id: message.id,
          type: 'claude:get-cards:response',
          payload: cardResponse,
          timestamp: Date.now(),
        });
        break;
      }

      case 'claude:start': {
        const sessionId = `mock-session-${Date.now()}`;

        await this.sendEncrypted(peer, {
          id: message.id,
          type: 'claude:start:response',
          payload: { success: true, sessionId },
          timestamp: Date.now(),
        });

        // Emit configured card events
        for (const event of this.cardEventsOnStart) {
          await this.sendEncrypted(peer, {
            id: `card-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: 'claude:card-event',
            payload: { ...event, sessionId },
            timestamp: Date.now(),
          });
        }

        // Send stream end
        const streamEnd: CardStreamEnd = {
          sessionId,
          success: true,
          totalCostUsd: 0.01,
          tokenUsage: { input: 100, output: 50 },
        };
        await this.sendEncrypted(peer, {
          id: `stream-end-${Date.now()}`,
          type: 'claude:card-stream-end',
          payload: streamEnd,
          timestamp: Date.now(),
        });
        break;
      }

      case 'claude:resume': {
        const resumePayload = message.payload as { sessionId: string; prompt: string };

        await this.sendEncrypted(peer, {
          id: message.id,
          type: 'claude:resume:response',
          payload: { success: true, sessionId: resumePayload.sessionId },
          timestamp: Date.now(),
        });

        // Send stream end
        await this.sendEncrypted(peer, {
          id: `stream-end-${Date.now()}`,
          type: 'claude:card-stream-end',
          payload: {
            sessionId: resumePayload.sessionId,
            success: true,
          } satisfies CardStreamEnd,
          timestamp: Date.now(),
        });
        break;
      }

      case 'git:status': {
        await this.sendEncrypted(peer, {
          id: message.id,
          type: 'git:status:response',
          payload: {
            branch: 'main',
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: [],
          },
          timestamp: Date.now(),
        });
        break;
      }

      case 'ai:get-api-key-status': {
        await this.sendEncrypted(peer, {
          id: message.id,
          type: 'ai:get-api-key-status:response',
          payload: { configured: false },
          timestamp: Date.now(),
        });
        break;
      }

      default:
        // Unhandled message type — ignore
        break;
    }
  }

  // ── Sending helpers ─────────────────────────────────────────────────────

  private sendRouted(peer: PeerState, payload: string): void {
    const envelope: RoutedEnvelope = {
      from: `agent:${this.agentId}`,
      to: `pwa:${peer.connectionId}`,
      payload,
    };
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(envelope));
    }
  }

  private async sendEncrypted(peer: PeerState, message: Message): Promise<void> {
    if (!peer.sessionDEK) {
      throw new Error('Cannot send encrypted message before key exchange');
    }
    const serialized = JSON.stringify(message);
    const compressed = compress(serialized);
    const encrypted = encryptWithSharedSecret(compressed, peer.sessionDEK);
    this.sendRouted(peer, encrypted);
  }

  // ── Public helpers for tests ────────────────────────────────────────────

  /** Push a card event to all connected peers. */
  async pushCardEvent(event: CardEvent): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.sessionDEK) {
        await this.sendEncrypted(peer, {
          id: `push-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'claude:card-event',
          payload: event,
          timestamp: Date.now(),
        });
      }
    }
  }

  /** Update mock sessions list (returned via /sessions/history snapshot when wired). */
  setSessions(sessions: ClaudeSessionSummary[]): void {
    this.sessions = sessions;
  }

  /** Update mock cards (affects future claude:get-cards responses). */
  setCards(cards: Card[]): void {
    this.cards = cards;
  }

  /** Update card events emitted after claude:start resolves. */
  setCardEventsOnStart(events: CardEvent[]): void {
    this.cardEventsOnStart = events;
  }
}
