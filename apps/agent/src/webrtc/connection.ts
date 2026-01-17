import { EventEmitter } from 'events';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'werift';
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

export interface ConnectionConfig {
  signalingServer: string;
  agentId: string;
  keyPair: { publicKey: string; secretKey: string };
  iceServers?: Array<{ urls: string | string[] }>;
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
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: ReturnType<RTCPeerConnection['createDataChannel']> | null = null;
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
      console.log('PWA peer connected, waiting for offer...');
    });

    this.signaling.on('offer', async (sdp: RTCSessionDescription) => {
      await this.handleOffer(sdp);
    });

    this.signaling.on('ice-candidate', async (candidate: RTCIceCandidate) => {
      await this.handleIceCandidate(candidate);
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

  private async handleOffer(sdp: RTCSessionDescription): Promise<void> {
    console.log('Received offer from PWA');

    // Create peer connection
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.config.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON());
      }
    };

    // Handle connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', this.peerConnection?.connectionState);
      if (this.peerConnection?.connectionState === 'connected') {
        this.isConnected = true;
        this.emit('connected');
      } else if (
        this.peerConnection?.connectionState === 'disconnected' ||
        this.peerConnection?.connectionState === 'failed'
      ) {
        this.handlePeerDisconnected();
      }
    };

    // Handle data channel
    this.peerConnection.ondatachannel = (event) => {
      console.log('Data channel received');
      this.setupDataChannel(event.channel);
    };

    // Set remote description and create answer
    await this.peerConnection.setRemoteDescription(sdp);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    // Send answer
    this.signaling.sendAnswer(answer);
    console.log('Sent answer to PWA');
  }

  private async handleIceCandidate(candidate: RTCIceCandidate): Promise<void> {
    if (this.peerConnection) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  private setupDataChannel(channel: ReturnType<RTCPeerConnection['createDataChannel']>): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      console.log('Data channel open');
    };

    channel.onclose = () => {
      console.log('Data channel closed');
      this.handlePeerDisconnected();
    };

    channel.onmessage = (event) => {
      this.handleDataChannelMessage(event.data);
    };
  }

  private handleDataChannelMessage(data: string): void {
    try {
      // First message should be the peer's public key for key exchange
      if (!this.peerPublicKey) {
        const keyExchange = JSON.parse(data);
        if (keyExchange.type === 'key-exchange') {
          this.peerPublicKey = decodeBase64(keyExchange.publicKey);
          this.sharedSecret = deriveSharedSecret(this.peerPublicKey, this.keyPair.secretKey);
          console.log('Key exchange complete, connection encrypted');

          // Send our public key back
          this.sendRaw(
            JSON.stringify({
              type: 'key-exchange',
              publicKey: encodeBase64(this.keyPair.publicKey),
            })
          );
          return;
        }
      }

      // Decrypt and parse message
      if (!this.sharedSecret) {
        console.error('No shared secret, cannot decrypt message');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, this.sharedSecret);
      const message = parseMessage(decrypted);
      this.emit('message', message);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  send(message: Message): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not open');
      return;
    }

    if (!this.sharedSecret) {
      console.error('No shared secret, cannot encrypt message');
      return;
    }

    const serialized = serializeMessage(message);
    const encrypted = encryptWithSharedSecret(serialized, this.sharedSecret);
    this.dataChannel.send(encrypted);
  }

  private sendRaw(data: string): void {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(data);
    }
  }

  private handlePeerDisconnected(): void {
    if (this.isConnected) {
      this.isConnected = false;
      this.emit('disconnected');
    }

    // Clean up
    this.dataChannel = null;
    this.peerPublicKey = null;
    this.sharedSecret = null;

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    console.log('Peer disconnected, waiting for new connection...');
  }

  disconnect(): void {
    this.signaling.disconnect();
    if (this.peerConnection) {
      this.peerConnection.close();
    }
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
