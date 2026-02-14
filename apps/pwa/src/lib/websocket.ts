import {
  generateKeyPair,
  decodeBase64,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  generateSessionDEK,
  encryptDEK,
  encodeBase64,
  parseMessage,
  serializeMessage,
  verifyLicense,
  type Message,
  type KeyPair,
  type License,
  type Repository,
} from '@sumicom/quicksave-shared';

export type ConnectionEventHandler = {
  onConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[]) => void;
  onDisconnected: () => void;
  onReconnecting: (attempt: number, maxAttempts: number) => void;
  onMessage: (message: Message) => void;
  onError: (error: Error) => void;
};

export class WebSocketClient {
  private signalingServer: string;
  private agentId: string;
  private agentPublicKey: Uint8Array;
  private keyPair: KeyPair;
  // Session DEK for encryption
  private sessionDEK: Uint8Array | null = null;
  private ws: WebSocket | null = null;
  private eventHandlers: ConnectionEventHandler;
  private keyExchangeComplete = false;

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

  // Gzip compression helpers
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

  async connect(): Promise<void> {
    // Connect to signaling server
    const wsUrl = `${this.signalingServer}/pwa/${this.agentId}`;
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not initialized'));

      this.ws.onopen = () => {
        console.log('Connected to signaling server');
        resolve();
      };

      this.ws.onmessage = async (event) => {
        const rawData = event.data instanceof Blob ? await event.data.text() : event.data;
        await this.handleMessage(rawData);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(new Error('Failed to connect to signaling server'));
      };

      this.ws.onclose = () => {
        console.log('WebSocket connection closed');
        this.handleDisconnection();
      };
    });
  }

  private async handleMessage(rawData: string): Promise<void> {
    try {
      // Try to parse as JSON (signaling message or key exchange)
      const parsed = JSON.parse(rawData);

      // Handle compressed signaling messages (z = zipped)
      if (parsed.z) {
        const message = JSON.parse(await this.decompress(parsed.z));
        await this.handleSignalingMessage(message);
        return;
      }

      // Handle signaling messages (only specific types from signaling server)
      const signalingTypes = ['peer-connected', 'peer-offline', 'bye', 'error'];
      if (parsed.type && signalingTypes.includes(parsed.type)) {
        await this.handleSignalingMessage(parsed);
        return;
      }

      // Handle key exchange or other JSON messages as data
      await this.handleDataMessage(rawData);
      return;
    } catch {
      // Not JSON, treat as raw data (encrypted message)
    }

    // Handle raw data message (encrypted data)
    await this.handleDataMessage(rawData);
  }

  private async handleSignalingMessage(message: { type: string; payload?: unknown }): Promise<void> {
    switch (message.type) {
      case 'peer-connected':
        console.log('Agent is online, initiating key exchange');
        this.initiateKeyExchange();
        break;

      case 'peer-offline':
        this.eventHandlers.onError(new Error('Agent is offline'));
        break;

      case 'bye':
        this.handleDisconnection();
        break;
    }
  }

  private initiateKeyExchange(): void {
    // V2 protocol: generate session DEK and encrypt it for the Agent
    this.sessionDEK = generateSessionDEK();
    const encryptedDEK = encryptDEK(this.sessionDEK, this.agentPublicKey);

    this.sendRaw(
      JSON.stringify({
        type: 'key-exchange',
        version: 2,
        encryptedDEK,
        timestamp: Date.now(),
      })
    );
  }

  private async handleDataMessage(data: string): Promise<void> {
    try {
      // Handle key exchange (uncompressed JSON)
      if (!this.keyExchangeComplete) {
        try {
          const response = JSON.parse(data);

          // Agent acknowledges with key-exchange-ack
          if (response.type === 'key-exchange-ack' && response.version === 2) {
            this.keyExchangeComplete = true;
            console.log('Key exchange complete, connection encrypted');
            this.requestHandshake();
            return;
          }
        } catch {
          // Not a key exchange message
          console.error('Received unexpected message before key exchange');
          return;
        }
      }

      // Post key-exchange: messages are encrypted, then the plaintext was compressed before encryption
      // Decrypt first, then decompress
      const encryptionKey = this.getEncryptionKey();
      if (!encryptionKey) {
        console.error('No encryption key available');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, encryptionKey);
      const decompressed = await this.decompress(decrypted);
      const message = parseMessage(decompressed);

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

  /**
   * Get the encryption key (session DEK)
   */
  private getEncryptionKey(): Uint8Array | null {
    return this.sessionDEK;
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
    const encryptionKey = this.getEncryptionKey();
    if (!encryptionKey) {
      console.error('No encryption key available');
      return;
    }

    // Compress before encryption for better compression ratio
    const serialized = serializeMessage(message);
    this.compress(serialized).then((compressed) => {
      const encrypted = encryptWithSharedSecret(compressed, encryptionKey);
      this.sendRaw(encrypted);
    });
  }

  private sendRaw(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.sessionDEK = null;
    this.keyExchangeComplete = false;
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

// Re-export as WebRTCClient for backwards compatibility during migration
export { WebSocketClient as WebRTCClient };
