import {
  generateKeyPair,
  decodeBase64,
  deriveSharedSecret,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  encodeBase64,
  parseMessage,
  serializeMessage,
  verifyLicense,
  type Message,
  type KeyPair,
  type License,
} from '@quicksave/shared';

export type ConnectionEventHandler = {
  onConnected: (repoPath: string, isPro: boolean) => void;
  onDisconnected: () => void;
  onReconnecting: (attempt: number, maxAttempts: number) => void;
  onMessage: (message: Message) => void;
  onError: (error: Error) => void;
};

export class WebRTCClient {
  private signalingServer: string;
  private agentId: string;
  private agentPublicKey: Uint8Array;
  private keyPair: KeyPair;
  private sharedSecret: Uint8Array | null = null;
  private ws: WebSocket | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private eventHandlers: ConnectionEventHandler;
  private keyExchangeComplete = false;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  // Auto-reconnect state
  private autoReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;
  private wasConnected = false;

  constructor(
    signalingServer: string,
    agentId: string,
    agentPublicKey: string,
    handlers: ConnectionEventHandler
  ) {
    this.signalingServer = signalingServer;
    this.agentId = agentId;
    this.agentPublicKey = decodeBase64(agentPublicKey);
    this.keyPair = generateKeyPair();
    this.eventHandlers = handlers;
  }

  async connect(): Promise<void> {
    // Connect to signaling server
    const wsUrl = `${this.signalingServer}/pwa/${this.agentId}`;
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not initialized'));

      this.ws.onopen = () => {
        console.log('Connected to signaling server');
        this.createPeerConnection();
        resolve();
      };

      this.ws.onmessage = async (event) => {
        const data = event.data instanceof Blob ? await event.data.text() : event.data;
        const message = JSON.parse(data);
        this.handleSignalingMessage(message);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(new Error('Failed to connect to signaling server'));
      };

      this.ws.onclose = () => {
        console.log('Signaling connection closed');
      };
    });
  }

  private createPeerConnection(): void {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    // Create data channel
    this.dataChannel = this.peerConnection.createDataChannel('quicksave', {
      ordered: true,
    });

    this.setupDataChannel(this.dataChannel);

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling({
          type: 'ice-candidate',
          payload: event.candidate.toJSON(),
        });
      }
    };

    // Handle connection state
    this.peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', this.peerConnection?.connectionState);
      if (
        this.peerConnection?.connectionState === 'disconnected' ||
        this.peerConnection?.connectionState === 'failed'
      ) {
        this.handleDisconnection();
      }
    };

    // Create and send offer
    this.createOffer();
  }

  private async createOffer(): Promise<void> {
    if (!this.peerConnection) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this.sendSignaling({
      type: 'offer',
      payload: offer,
    });
  }

  private async handleSignalingMessage(message: { type: string; payload?: unknown }): Promise<void> {
    switch (message.type) {
      case 'peer-offline':
        this.eventHandlers.onError(new Error('Agent is offline'));
        break;

      case 'answer':
        if (this.peerConnection) {
          await this.peerConnection.setRemoteDescription(
            new RTCSessionDescription(message.payload as RTCSessionDescriptionInit)
          );
          this.remoteDescriptionSet = true;

          // Process any queued ICE candidates
          for (const candidate of this.pendingIceCandidates) {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          }
          this.pendingIceCandidates = [];
        }
        break;

      case 'ice-candidate':
        if (this.peerConnection) {
          const candidate = message.payload as RTCIceCandidateInit;
          if (this.remoteDescriptionSet) {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            // Queue candidate until remote description is set
            this.pendingIceCandidates.push(candidate);
          }
        }
        break;
    }
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log('Data channel open, initiating key exchange');
      // Send our public key for key exchange
      channel.send(
        JSON.stringify({
          type: 'key-exchange',
          publicKey: encodeBase64(this.keyPair.publicKey),
        })
      );
    };

    channel.onclose = () => {
      console.log('Data channel closed');
      this.handleDisconnection();
    };

    channel.onmessage = (event) => {
      this.handleDataChannelMessage(event.data);
    };

    channel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.eventHandlers.onError(new Error('Data channel error'));
    };
  }

  private handleDataChannelMessage(data: string): void {
    try {
      // Handle key exchange response
      if (!this.keyExchangeComplete) {
        const keyExchange = JSON.parse(data);
        if (keyExchange.type === 'key-exchange') {
          // Verify the public key matches what we expected
          const receivedKey = decodeBase64(keyExchange.publicKey);
          if (encodeBase64(receivedKey) !== encodeBase64(this.agentPublicKey)) {
            this.eventHandlers.onError(new Error('Public key mismatch - possible MITM attack'));
            this.disconnect();
            return;
          }

          // Derive shared secret
          this.sharedSecret = deriveSharedSecret(this.agentPublicKey, this.keyPair.secretKey);
          this.keyExchangeComplete = true;
          console.log('Key exchange complete, connection encrypted');

          // Request initial status and check for license
          this.requestHandshake();
          return;
        }
      }

      // Decrypt message
      if (!this.sharedSecret) {
        console.error('No shared secret');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, this.sharedSecret);
      const message = parseMessage(decrypted);

      // Handle handshake response
      if (message.type === 'handshake:ack') {
        const payload = message.payload as { repoPath: string; license?: License };
        const isPro = payload.license ? verifyLicense(payload.license) : false;
        this.wasConnected = true;
        this.reconnectAttempts = 0;
        this.eventHandlers.onConnected(payload.repoPath, isPro);
        return;
      }

      this.eventHandlers.onMessage(message);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  private requestHandshake(): void {
    this.send({
      id: `handshake-${Date.now()}`,
      type: 'handshake',
      payload: {
        publicKey: encodeBase64(this.keyPair.publicKey),
      },
      timestamp: Date.now(),
    });
  }

  send(message: Message): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not open');
      return;
    }

    if (!this.sharedSecret) {
      console.error('No shared secret');
      return;
    }

    const serialized = serializeMessage(message);
    const encrypted = encryptWithSharedSecret(serialized, this.sharedSecret);
    this.dataChannel.send(encrypted);
  }

  private sendSignaling(message: { type: string; payload?: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleDisconnection(): void {
    // Clean up current connection
    this.cleanupConnection();

    // Don't reconnect if this was a manual disconnect
    if (this.isManualDisconnect) {
      this.eventHandlers.onDisconnected();
      return;
    }

    // Only attempt reconnect if we were previously connected
    if (this.wasConnected && this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.eventHandlers.onDisconnected();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.eventHandlers.onReconnecting(this.reconnectAttempts, this.maxReconnectAttempts);

    this.reconnectTimeout = setTimeout(() => {
      this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    try {
      // Generate new key pair for fresh connection
      this.keyPair = generateKeyPair();
      await this.connect();
      // Reset reconnect state on successful connection
      this.reconnectAttempts = 0;
    } catch (error) {
      console.error('Reconnection failed:', error);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        this.eventHandlers.onError(new Error('Failed to reconnect after multiple attempts'));
        this.eventHandlers.onDisconnected();
      }
    }
  }

  private cleanupConnection(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.sharedSecret = null;
    this.keyExchangeComplete = false;
    this.pendingIceCandidates = [];
    this.remoteDescriptionSet = false;
  }

  disconnect(): void {
    this.isManualDisconnect = true;
    this.autoReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.cleanupConnection();
    this.eventHandlers.onDisconnected();
  }
}
