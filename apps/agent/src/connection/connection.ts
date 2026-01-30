import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import {
  generateKeyPair,
  encodeKeyPair,
  decodeKeyPair,
  deriveSharedSecret,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  encodeBase64,
  decodeBase64,
  parseMessage,
  serializeMessage,
  type Message,
  type KeyPair,
} from '@quicksave/shared';
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
  private peerPublicKey: Uint8Array | null = null;
  private sharedSecret: Uint8Array | null = null;
  private isConnected = false;

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
      if (!this.peerPublicKey) {
        // Try to parse as key exchange message
        try {
          const keyExchange = JSON.parse(data);
          if (keyExchange.type === 'key-exchange') {
            this.peerPublicKey = decodeBase64(keyExchange.publicKey);
            this.sharedSecret = deriveSharedSecret(this.peerPublicKey, this.keyPair.secretKey);
            console.log('Key exchange complete, connection encrypted');

            // Mark as connected
            if (!this.isConnected) {
              this.isConnected = true;
              this.emit('connected');
            }

            // Send our public key back
            this.sendRaw(
              JSON.stringify({
                type: 'key-exchange',
                publicKey: encodeBase64(this.keyPair.publicKey),
              })
            );
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
      if (!this.sharedSecret) {
        console.error('No shared secret, cannot decrypt message');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, this.sharedSecret);
      const buffer = Buffer.from(decrypted, 'base64');
      const decompressed = await gunzipAsync(buffer);
      const message = parseMessage(decompressed.toString('utf-8'));
      this.emit('message', message);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  send(message: Message): void {
    if (!this.sharedSecret) {
      console.error('No shared secret, cannot encrypt message');
      return;
    }

    // Compress before encryption for better compression ratio
    const serialized = serializeMessage(message);
    gzipAsync(Buffer.from(serialized)).then((compressed) => {
      const compressedBase64 = compressed.toString('base64');
      const encrypted = encryptWithSharedSecret(compressedBase64, this.sharedSecret!);
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
    this.peerPublicKey = null;
    this.sharedSecret = null;

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
