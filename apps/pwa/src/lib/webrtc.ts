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
  type Repository,
} from '@quicksave/shared';

export type ConnectionEventHandler = {
  onConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[]) => void;
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

  // Relay mode state (fallback when P2P fails)
  private relayMode = false;
  private iceTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly ICE_TIMEOUT_MS = 10000;

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

  // Gzip compression helpers for signaling (base64 string output)
  private async compress(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const stream = new Blob([encoder.encode(data)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const compressed = await new Response(stream).arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(compressed)));
  }

  private async decompress(base64: string): Promise<string> {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  // Binary compression helpers for data channel (ArrayBuffer output - more efficient)
  private async compressForDataChannel(data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const stream = new Blob([encoder.encode(data)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  private async decompressFromDataChannel(data: ArrayBuffer): Promise<string> {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
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
        const rawData = event.data instanceof Blob ? await event.data.text() : event.data;
        const parsed = JSON.parse(rawData);
        // Handle compressed messages (z = zipped)
        const message = parsed.z
          ? JSON.parse(await this.decompress(parsed.z))
          : parsed;
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

    // Handle ICE connection state for relay fallback
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log('ICE connection state:', state);

      if (state === 'connected' || state === 'completed') {
        // P2P connection established, clear ICE timeout
        if (this.iceTimeout) {
          clearTimeout(this.iceTimeout);
          this.iceTimeout = null;
        }
      } else if (state === 'failed') {
        // ICE failed, switch to relay mode
        this.enableRelayMode();
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

    // Set ICE timeout - if P2P doesn't connect in time, fall back to relay
    this.iceTimeout = setTimeout(() => {
      if (
        this.peerConnection?.iceConnectionState === 'checking' ||
        this.peerConnection?.iceConnectionState === 'new'
      ) {
        console.log('ICE timeout - switching to relay mode');
        this.enableRelayMode();
      }
    }, this.ICE_TIMEOUT_MS);

    // Create and send offer
    this.createOffer();
  }

  private enableRelayMode(): void {
    if (this.relayMode) return;

    console.log('Enabling WebSocket relay mode');
    this.relayMode = true;

    // Clear ICE timeout
    if (this.iceTimeout) {
      clearTimeout(this.iceTimeout);
      this.iceTimeout = null;
    }

    // Close P2P connection
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Send relay mode activation to agent via signaling
    this.sendSignaling({ type: 'relay-mode' });

    // Initiate key exchange over WebSocket
    this.initiateRelayKeyExchange();
  }

  private initiateRelayKeyExchange(): void {
    // Send our public key for key exchange via relay
    this.sendSignaling({
      type: 'relay-data',
      payload: JSON.stringify({
        type: 'key-exchange',
        publicKey: encodeBase64(this.keyPair.publicKey),
      }),
    });
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

      case 'relay-data':
        // Handle data relayed through WebSocket (when P2P fails)
        if (this.relayMode && typeof message.payload === 'string') {
          this.handleDataChannelMessage(message.payload);
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

  private async handleDataChannelMessage(data: string | ArrayBuffer): Promise<void> {
    try {
      let strData: string;

      // Handle key exchange (uncompressed string) vs encrypted messages (compressed)
      if (!this.keyExchangeComplete) {
        // Key exchange messages are uncompressed strings
        if (typeof data === 'string') {
          strData = data;
        } else if (this.relayMode) {
          // Relay mode: base64 string from WebSocket
          strData = data as unknown as string;
        } else {
          // Shouldn't happen during key exchange, but handle gracefully
          strData = new TextDecoder().decode(data);
        }

        const keyExchange = JSON.parse(strData);
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

      // Post key-exchange: all messages are compressed
      if (data instanceof ArrayBuffer) {
        // Binary data from data channel - decompress
        strData = await this.decompressFromDataChannel(data);
      } else if (this.relayMode) {
        // Base64 string from relay - decode and decompress
        const binary = atob(data);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        strData = await this.decompressFromDataChannel(bytes.buffer);
      } else {
        // Fallback for uncompressed string (shouldn't happen after key exchange)
        strData = data;
      }

      // Decrypt message
      if (!this.sharedSecret) {
        console.error('No shared secret');
        return;
      }

      const decrypted = decryptWithSharedSecret(strData, this.sharedSecret);
      const message = parseMessage(decrypted);

      // Handle handshake response
      if (message.type === 'handshake:ack') {
        const payload = message.payload as { repoPath: string; license?: License; availableRepos?: Repository[] };
        const isPro = payload.license ? verifyLicense(payload.license) : false;
        this.wasConnected = true;
        this.reconnectAttempts = 0;
        this.eventHandlers.onConnected(payload.repoPath, isPro, payload.availableRepos);
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
    if (!this.sharedSecret) {
      console.error('No shared secret');
      return;
    }

    const serialized = serializeMessage(message);
    const encrypted = encryptWithSharedSecret(serialized, this.sharedSecret);

    // Compress the encrypted payload before sending
    this.compressForDataChannel(encrypted).then((compressed) => {
      if (this.relayMode) {
        // Send through WebSocket relay - convert to base64 since WebSocket needs string
        const base64 = btoa(String.fromCharCode(...new Uint8Array(compressed)));
        this.sendSignaling({
          type: 'relay-data',
          payload: base64,
        });
      } else {
        // Send through WebRTC data channel as binary
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
          console.error('Data channel not open');
          return;
        }
        this.dataChannel.send(compressed);
      }
    });
  }

  private async sendSignaling(message: { type: string; payload?: unknown }): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(message);
      const compressed = await this.compress(json);
      this.ws.send(JSON.stringify({ z: compressed }));
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
    if (this.iceTimeout) {
      clearTimeout(this.iceTimeout);
      this.iceTimeout = null;
    }

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
    this.relayMode = false;
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
