import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import {
  generateKeyPair,
  encodeKeyPair,
  decodeKeyPair,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  decryptDEK,
  parseMessage,
  serializeMessage,
  type Message,
  type KeyPair,
  type KeyExchangeV2,
} from '@sumicom/quicksave-shared';
import { SignalingClient } from './relay.js';
import { PubSub, sessionTopic, BROADCAST_TOPIC } from './pubsub.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ConnectionConfig {
  signalingServer: string;
  agentId: string;
  keyPair: { publicKey: string; secretKey: string };
}

export interface PeerSession {
  address: string;
  sessionDEK: Uint8Array;
  connectedAt: number;
}

export interface AgentConnectionEvents {
  connected: (peerAddress: string) => void;
  disconnected: (peerAddress: string) => void;
  message: (message: Message, peerAddress: string) => void;
  error: (error: Error) => void;
}

export class AgentConnection extends EventEmitter {
  private config: ConnectionConfig;
  private signaling: SignalingClient;
  private keyPair: KeyPair;
  private peers: Map<string, PeerSession> = new Map();
  private pubsub = new PubSub();

  // Key exchange replay protection
  private static readonly KEY_EXCHANGE_MAX_AGE_MS = 60000; // 60 seconds

  constructor(config: ConnectionConfig) {
    super();
    this.config = config;
    this.keyPair = decodeKeyPair(config.keyPair);
    this.signaling = new SignalingClient(config.signalingServer, config.agentId);
    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers(): void {
    this.signaling.on('peer-connected', () => {
      console.log('PWA peer connected, waiting for key exchange...');
    });

    this.signaling.on('data', (data: string, from: string | null) => {
      this.handleDataMessage(data, from);
    });

    this.signaling.on('peer-disconnected', () => {
      // Legacy compatibility: only affects legacy (non-key-based) peers
      // Key-based peers use 'pwa-bye' for targeted disconnect
      for (const [address] of this.peers) {
        this.handlePeerDisconnected(address);
      }
    });

    // Targeted disconnect for key-based PWAs
    this.signaling.on('pwa-bye', (pwaAddress: string) => {
      this.handlePeerDisconnected(pwaAddress);
    });

    // Reset encryption state when WebSocket reconnects (before peer-disconnected)
    this.signaling.on('disconnected', () => {
      // Clear all peers and their pubsub subscriptions
      for (const [address] of this.peers) {
        this.pubsub.unsubscribeAll(address);
        this.emit('disconnected', address);
      }
      this.peers.clear();
    });

    this.signaling.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  async start(): Promise<void> {
    console.log('Connecting to signaling server...');
    await this.signaling.connect();
    console.log('Connected to signaling server');
    console.log(`Agent ID: ${this.config.agentId}`);
    console.log(`Public Key: ${this.config.keyPair.publicKey}`);
  }

  private async handleDataMessage(data: string, from: string | null): Promise<void> {
    try {
      // Always check for key-exchange messages first
      // Always accept new key-exchange (PWA may have refreshed with new DEK)
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'key-exchange') {
          await this.handleKeyExchange(parsed, from);
          return;
        }
      } catch {
        // Not JSON - continue to encrypted message handling
      }

      // Look up peer by from address to get correct DEK
      if (!from) {
        console.error('Received encrypted message with no sender address');
        return;
      }

      const peer = this.peers.get(from);
      if (!peer) {
        console.error(`No peer session found for ${from}`);
        return;
      }

      // Post key-exchange: messages are encrypted, then the plaintext was compressed before encryption
      // Decrypt first, then decompress
      const decrypted = decryptWithSharedSecret(data, peer.sessionDEK);
      const buffer = Buffer.from(decrypted, 'base64');
      const decompressed = await gunzipAsync(buffer);
      const message = parseMessage(decompressed.toString('utf-8'));
      this.emit('message', message, from);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  /**
   * Handle key exchange message
   */
  private async handleKeyExchange(message: KeyExchangeV2, from: string | null): Promise<void> {
    // Verify timestamp for replay protection
    const age = Date.now() - message.timestamp;
    if (age > AgentConnection.KEY_EXCHANGE_MAX_AGE_MS) {
      console.error(`Key exchange expired (age: ${age}ms)`);
      this.emit('error', new Error('Key exchange expired'));
      return;
    }

    if (age < -5000) {
      // Allow 5 second clock skew into the future
      console.error(`Key exchange timestamp in future (age: ${age}ms)`);
      this.emit('error', new Error('Key exchange timestamp invalid'));
      return;
    }

    // Decrypt the session DEK
    try {
      const sessionDEK = decryptDEK(message.encryptedDEK, this.keyPair.secretKey);
      const peerAddress = from || 'unknown';
      const peerKey = peerAddress.replace('pwa:', '');
      console.log(`Key exchange complete with ${peerKey.slice(0, 12)}..., connection encrypted`);

      const isReconnect = this.peers.has(peerAddress);

      if (isReconnect) {
        // Peer reconnected with new DEK — clean up old session state first
        this.emit('disconnected', peerAddress);
      }

      // Create/update PeerSession for that address
      this.peers.set(peerAddress, {
        address: peerAddress,
        sessionDEK,
        connectedAt: Date.now(),
      });

      this.emit('connected', peerAddress);

      // Auto-subscribe new peers to broadcast topic
      this.pubsub.subscribe(peerAddress, BROADCAST_TOPIC);

      // V2: Send acknowledgment
      const ack = JSON.stringify({
        type: 'key-exchange-ack',
        version: 2,
      });
      this.signaling.sendData(ack, peerAddress);
    } catch (error) {
      console.error('Failed to decrypt session DEK:', error);
      this.emit('error', new Error('Failed to decrypt session DEK'));
    }
  }

  // Per-peer send queue to guarantee message ordering.
  // gzipAsync is non-blocking — without serialization, fast consecutive
  // send() calls can compress out of order and arrive at the relay scrambled.
  private sendQueues: Map<string, Promise<void>> = new Map();

  send(message: Message, targetAddress: string): void {
    const peer = this.peers.get(targetAddress);
    if (!peer) {
      console.error(`No peer session for ${targetAddress}, cannot encrypt message`);
      return;
    }

    const serialized = serializeMessage(message);
    const prev = this.sendQueues.get(targetAddress) ?? Promise.resolve();
    const next = prev.then(async () => {
      // Re-check peer: may have disconnected while queued
      if (!this.peers.has(targetAddress)) return;
      const compressed = await gzipAsync(Buffer.from(serialized));
      const compressedBase64 = compressed.toString('base64');
      const encrypted = encryptWithSharedSecret(compressedBase64, peer.sessionDEK);
      this.signaling.sendData(encrypted, targetAddress);
    }).catch((error) => {
      console.error('Failed to send message:', error);
    });
    this.sendQueues.set(targetAddress, next);
  }

  private handlePeerDisconnected(peerAddress: string): void {
    if (this.peers.has(peerAddress)) {
      this.peers.delete(peerAddress);
      const removedTopics = this.pubsub.unsubscribeAll(peerAddress);
      if (removedTopics.size > 0) {
        console.log(`[disconnect] ${peerAddress.slice(0, 12)} removed from ${removedTopics.size} topics`);
      }
      this.emit('disconnected', peerAddress);
    }

    console.log('Peer disconnected, waiting for new connection...');
  }

  disconnect(): void {
    this.signaling.disconnect();
  }

  getPublicKey(): string {
    return this.config.keyPair.publicKey;
  }

  getAgentId(): string {
    return this.config.agentId;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  hasPeers(): boolean {
    return this.peers.size > 0;
  }

  /**
   * Register which session a peer is currently viewing.
   * Returns true if this is a NEW subscription (peer was not already on this session topic).
   */
  subscribePeerToSession(peerAddress: string, sessionId: string): boolean {
    const topic = sessionTopic(sessionId);
    const isNew = this.pubsub.subscribe(peerAddress, topic);
    if (isNew) {
      console.log(`[sub] ${peerAddress.slice(0, 12)} → ${sessionId.slice(0, 8)}`);
    }
    // Ensure broadcast subscription
    this.pubsub.subscribe(peerAddress, BROADCAST_TOPIC);
    return isNew;
  }

  /**
   * Remove a peer's session subscription.
   * Called when the PWA explicitly unsubscribes from a session.
   */
  unsubscribePeerFromSession(peerAddress: string, sessionId: string): void {
    const topic = sessionTopic(sessionId);
    this.pubsub.unsubscribe(peerAddress, topic);
    console.log(`[unsub] ${peerAddress.slice(0, 12)} x ${sessionId.slice(0, 8)}`);
  }

  /** Debug snapshot of peers and pubsub state. */
  getDebugState(): { peers: Array<{ address: string; connectedAt: number; topics: string[] }>; subscriptions: Record<string, string[]> } {
    const peers = Array.from(this.peers.entries()).map(([addr, ps]) => ({
      address: addr.slice(0, 16),
      connectedAt: ps.connectedAt,
      topics: [...(this.pubsub.topicsOf(addr))],
    }));
    const { topics } = this.pubsub.getState();
    const subscriptions: Record<string, string[]> = {};
    for (const [topic, addrs] of Object.entries(topics)) {
      subscriptions[topic] = addrs.map(a => a.slice(0, 16));
    }
    return { peers, subscriptions };
  }

  /** Send a message to all connected peers via broadcast topic. */
  broadcast(message: Message): void {
    const subscribers = this.pubsub.subscribers(BROADCAST_TOPIC);
    if (subscribers.size > 0) {
      for (const address of subscribers) {
        if (this.peers.has(address)) {
          this.send(message, address);
        }
      }
    } else {
      // Fallback: peers connected but haven't subscribed yet
      for (const [address] of this.peers) {
        this.send(message, address);
      }
    }
  }

  /** Send a message only to peers subscribed to a specific session. Returns number of peers sent to. */
  sendToSession(sessionId: string, message: Message): number {
    const topic = sessionTopic(sessionId);
    const subscribers = this.pubsub.subscribers(topic);
    let sent = 0;
    for (const address of subscribers) {
      if (this.peers.has(address)) {
        this.send(message, address);
        sent++;
      }
    }
    if (sent === 0) {
      const msgType = message.type;
      const eventType = (message.payload as any)?.eventType;
      if (eventType || msgType === 'claude:user-input-request') {
        console.warn(`[sendToSession] NO peers for session=${sessionId.slice(0, 8)} type=${msgType} peers=${this.peers.size}`);
      }
    }
    return sent;
  }
}

/**
 * Generate and encode a new key pair for the agent
 */
export function generateAgentKeyPair(): { publicKey: string; secretKey: string } {
  return encodeKeyPair(generateKeyPair());
}
