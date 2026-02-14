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
} from 'quicksave-shared';
import { SignalingClient } from './signaling.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ConnectionConfig {
  signalingServer: string;
  agentId: string;
  keyPair: { publicKey: string; secretKey: string };
}

export interface WebRTCConnectionEvents {
  connected: () => void;
  disconnected: () => void;
  message: (message: Message) => void;
  error: (error: Error) => void;
}

export class WebRTCConnection extends EventEmitter {
  private config: ConnectionConfig;
  private signaling: SignalingClient;
  private keyPair: KeyPair;
  // Session DEK for encryption (received encrypted from PWA)
  private sessionDEK: Uint8Array | null = null;
  private isConnected = false;

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

    this.signaling.on('data', (data: string) => {
      this.handleDataMessage(data);
    });

    this.signaling.on('peer-disconnected', () => {
      this.handlePeerDisconnected();
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

  private async handleDataMessage(data: string): Promise<void> {
    try {
      // Handle key exchange (uncompressed JSON) vs encrypted messages (base64 compressed)
      if (!this.isKeyExchangeComplete()) {
        // Try to parse as key exchange message
        try {
          const keyExchange = JSON.parse(data);
          if (keyExchange.type === 'key-exchange') {
            await this.handleKeyExchange(keyExchange);
            return;
          }
        } catch {
          // Not a key exchange message, ignore until key exchange completes
          console.error('Received message before key exchange');
          return;
        }
      }

      // Post key-exchange: messages are encrypted, then the plaintext was compressed before encryption
      // Decrypt first, then decompress
      const encryptionKey = this.getEncryptionKey();
      if (!encryptionKey) {
        console.error('No encryption key, cannot decrypt message');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, encryptionKey);
      const buffer = Buffer.from(decrypted, 'base64');
      const decompressed = await gunzipAsync(buffer);
      const message = parseMessage(decompressed.toString('utf-8'));
      this.emit('message', message);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  /**
   * Check if key exchange has completed
   */
  private isKeyExchangeComplete(): boolean {
    return this.sessionDEK !== null;
  }

  /**
   * Get the encryption key
   */
  private getEncryptionKey(): Uint8Array | null {
    return this.sessionDEK;
  }

  /**
   * Handle key exchange message
   */
  private async handleKeyExchange(message: KeyExchangeV2): Promise<void> {
    // Verify timestamp for replay protection
    const age = Date.now() - message.timestamp;
    if (age > WebRTCConnection.KEY_EXCHANGE_MAX_AGE_MS) {
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
      this.sessionDEK = decryptDEK(message.encryptedDEK, this.keyPair.secretKey);
      console.log('Key exchange complete, connection encrypted');

      // Mark as connected
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit('connected');
      }

      // V2: Send acknowledgment
      this.sendRaw(
        JSON.stringify({
          type: 'key-exchange-ack',
          version: 2,
        })
      );
    } catch (error) {
      console.error('Failed to decrypt session DEK:', error);
      this.emit('error', new Error('Failed to decrypt session DEK'));
    }
  }

  send(message: Message): void {
    const encryptionKey = this.getEncryptionKey();
    if (!encryptionKey) {
      console.error('No encryption key, cannot encrypt message');
      return;
    }

    // Compress before encryption for better compression ratio
    const serialized = serializeMessage(message);
    gzipAsync(Buffer.from(serialized)).then((compressed) => {
      const compressedBase64 = compressed.toString('base64');
      const encrypted = encryptWithSharedSecret(compressedBase64, encryptionKey);
      this.signaling.sendData(encrypted);
    });
  }

  private sendRaw(data: string): void {
    this.signaling.sendData(data);
  }

  private handlePeerDisconnected(): void {
    if (this.isConnected) {
      this.isConnected = false;
      this.emit('disconnected');
    }

    // Clean up encryption state for next connection
    this.sessionDEK = null;

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
}

/**
 * Generate and encode a new key pair for the agent
 */
export function generateAgentKeyPair(): { publicKey: string; secretKey: string } {
  return encodeKeyPair(generateKeyPair());
}
