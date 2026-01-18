import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { SignalingMessage } from '@quicksave/shared';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// WebRTC types (simplified for Node.js wrtc module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDPInit = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ICECandidateInit = any;

export interface SignalingEvents {
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  offer: (sdp: SDPInit) => void;
  answer: (sdp: SDPInit) => void;
  'ice-candidate': (candidate: ICECandidateInit) => void;
  'relay-mode': () => void;
  'relay-data': (data: string) => void;
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
            // Handle compressed messages (z = zipped)
            const message: SignalingMessage = parsed.z
              ? JSON.parse(await this.decompress(parsed.z))
              : parsed;
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse signaling message:', error);
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
      case 'offer':
        this.emit('offer', message.payload);
        break;
      case 'answer':
        this.emit('answer', message.payload);
        break;
      case 'ice-candidate':
        this.emit('ice-candidate', message.payload);
        break;
      case 'relay-mode':
        this.emit('relay-mode');
        break;
      case 'relay-data':
        if (typeof message.payload === 'string') {
          this.emit('relay-data', message.payload);
        }
        break;
      case 'bye':
        this.emit('peer-disconnected');
        break;
    }
  }

  sendOffer(sdp: SDPInit): void {
    this.send({ type: 'offer', payload: sdp });
  }

  sendAnswer(sdp: SDPInit): void {
    this.send({ type: 'answer', payload: sdp });
  }

  sendIceCandidate(candidate: ICECandidateInit): void {
    this.send({ type: 'ice-candidate', payload: candidate });
  }

  sendBye(): void {
    this.send({ type: 'bye' });
  }

  sendRelayData(data: string): void {
    this.send({ type: 'relay-data', payload: data });
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
