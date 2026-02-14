import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { SignalingMessage } from 'quicksave-shared';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SignalingEvents {
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  data: (data: string) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private agentId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnected = false;

  constructor(signalingServer: string, agentId: string) {
    super();
    this.url = `${signalingServer}/agent/${agentId}`;
    this.agentId = agentId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', async (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            // Handle compressed signaling messages (z = zipped)
            if (parsed.z) {
              const message: SignalingMessage = JSON.parse(await this.decompress(parsed.z));
              this.handleMessage(message);
              return;
            }
            // Handle signaling messages (only specific types from signaling server)
            const signalingTypes = ['peer-connected', 'peer-offline', 'data', 'bye', 'error'];
            if (parsed.type && signalingTypes.includes(parsed.type)) {
              this.handleMessage(parsed as SignalingMessage);
              return;
            }
            // Other JSON messages (like key-exchange) are data messages
            this.emit('data', data.toString());
          } catch {
            // Not JSON, treat as raw data message
            this.emit('data', data.toString());
          }
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (error) => {
          this.emit('error', error);
          if (!this.isConnected) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: SignalingMessage): void {
    switch (message.type) {
      case 'peer-connected':
        this.emit('peer-connected');
        break;
      case 'peer-offline':
        this.emit('peer-disconnected');
        break;
      case 'data':
        if (typeof message.payload === 'string') {
          this.emit('data', message.payload);
        }
        break;
      case 'bye':
        this.emit('peer-disconnected');
        break;
    }
  }

  sendBye(): void {
    this.send({ type: 'bye' });
  }

  sendData(data: string): void {
    // Send raw data to peer through signaling server
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // Gzip compression helpers
  private async compress(data: string): Promise<string> {
    const buffer = await gzipAsync(Buffer.from(data));
    return buffer.toString('base64');
  }

  private async decompress(base64: string): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    const decompressed = await gunzipAsync(buffer);
    return decompressed.toString('utf-8');
  }

  private send(message: SignalingMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send compressed
      this.compress(JSON.stringify(message)).then((compressed) => {
        this.ws?.send(JSON.stringify({ z: compressed }));
      });
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((error) => {
        console.error('Reconnect failed:', error);
      });
    }, delay);
  }

  disconnect(): void {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    if (this.ws) {
      this.sendBye();
      this.ws.close();
      this.ws = null;
    }
  }

  getAgentId(): string {
    return this.agentId;
  }

  getConnectionUrl(): string {
    return this.url;
  }
}
