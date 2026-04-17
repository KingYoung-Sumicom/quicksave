import {
  decodeBase64,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  generateSessionDEK,
  encryptDEK,
  encodeBase64,
  parseMessage,
  serializeMessage,
  verifyLicense,
  generateKeyPair,
  type Message,
  type KeyPair,
  type License,
  type Repository,
  type CodingPath,
  type ClaudePreferences,
  type CodexModelInfo,
  type HandshakeAckPayload,
} from '@sumicom/quicksave-shared';

export type ConnectionStep = 'signaling' | 'waiting-for-agent' | 'key-exchange' | 'handshake';

export type ConnectionEventHandler = {
  onConnected: (agentId: string, repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[], preferences?: ClaudePreferences, agentVersion?: string, latestVersion?: string, devBuild?: boolean, codexModels?: CodexModelInfo[]) => void;
  onDisconnected: (agentId?: string) => void;
  onReconnecting: (attempt: number, maxAttempts: number) => void;
  onMessage: (message: Message) => void;
  onError: (error: Error) => void;
  onConnectionStep: (step: ConnectionStep, attempt?: number) => void;
  onAgentStatus: (agentId: string, online: boolean) => void;
};

/**
 * Per-agent session state tracking key exchange, encryption, etc.
 */
interface AgentSession {
  agentId: string;
  agentPublicKey: Uint8Array;
  sessionDEK: Uint8Array | null;
  keyExchangeComplete: boolean;
  keyPair: KeyPair; // ephemeral per session
  keyExchangeRetries: number;
  keyExchangeTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Routing envelope for messages sent through the signaling server.
 */
interface RoutedEnvelope {
  from: string;
  to: string;
  payload: string;
}

/** Message types that should be relayed across tabs via BroadcastChannel.
 *  Only broadcast-scoped events belong here — session-scoped events
 *  (stream, stream:end, user-input-request) are delivered directly
 *  to the subscribed peer via sendToSession on the agent side. */
const CROSS_TAB_MESSAGE_TYPES = new Set([
  'claude:session-updated', 'claude:preferences-updated',
  'claude:user-input-resolved', 'session:history-updated',
  'ai:commit-summary:updated',
]);

export class WebSocketClient {
  private signalingServer: string;
  private connectionId: string; // Unique per window to allow multiple tabs
  private ws: WebSocket | null = null;
  private eventHandlers: ConnectionEventHandler;

  // Multi-agent session tracking
  private sessions: Map<string, AgentSession> = new Map();
  private activeAgentId: string | null = null;
  private connectPromise: Promise<void> | null = null;

  // Cross-tab message relay: the tab with the active relay connection
  // broadcasts push messages to other tabs via BroadcastChannel.
  private crossTabChannel: BroadcastChannel | null = null;

  // Serialize incoming message processing — decompress is async and without
  // serialization, rapid WebSocket messages can resolve out of order.
  private messageQueue: Promise<void> = Promise.resolve();

  // Auto-reconnect state (for the WebSocket connection itself)
  private autoReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;
  private wasConnected = false;

  // Key exchange retry config
  private static readonly MAX_KEY_EXCHANGE_RETRIES = 5;
  private static readonly KEY_EXCHANGE_BASE_DELAY = 2000;

  constructor(
    signalingServer: string,
    identityPublicKey: string,
    handlers: ConnectionEventHandler
  ) {
    this.signalingServer = signalingServer;
    const suffix = Math.random().toString(36).slice(2, 10);
    this.connectionId = `${identityPublicKey}-${suffix}`;
    this.eventHandlers = handlers;

    // Cross-tab relay: listen for push messages broadcast by the tab that owns the relay connection
    this.crossTabChannel = new BroadcastChannel('quicksave-agent-push');
    this.crossTabChannel.onmessage = (event) => {
      const message = event.data as Message;
      if (message?.type && CROSS_TAB_MESSAGE_TYPES.has(message.type)) {
        this.eventHandlers.onMessage(message);
      }
    };
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

  /**
   * Connect the single persistent WebSocket to /pwa/key/{identityPublicKey}
   */
  async connect(): Promise<void> {
    // Re-enable auto-reconnect in case it was stopped by stopReconnecting()
    this.autoReconnect = true;
    this.isManualDisconnect = false;

    const wsUrl = `${this.signalingServer}/pwa/${encodeURIComponent(this.connectionId)}`;
    this.ws = new WebSocket(wsUrl);

    this.connectPromise = new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not initialized'));

      this.ws.onopen = () => {
        console.log('Connected to signaling server (key-based)');
        this.wasConnected = true;
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        // Chain onto messageQueue to guarantee in-order processing.
        // Without this, concurrent async decompress can resolve out of order.
        this.messageQueue = this.messageQueue.then(async () => {
          const rawData = event.data instanceof Blob ? await event.data.text() : event.data;
          await this.handleMessage(rawData);
        }).catch((err) => console.error('Message processing error:', err));
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

    return this.connectPromise;
  }

  /**
   * Start a new agent session. Creates the session state and initiates key exchange.
   */
  connectToAgent(agentId: string, publicKey: string): void {
    // Clean up existing session for this agent if any
    this.cleanupAgentSession(agentId);

    const session: AgentSession = {
      agentId,
      agentPublicKey: decodeBase64(publicKey),
      sessionDEK: null,
      keyExchangeComplete: false,
      keyPair: generateKeyPair(),
      keyExchangeRetries: 0,
      keyExchangeTimeout: null,
    };

    this.sessions.set(agentId, session);
    this.activeAgentId = agentId;

    // Send watch-agent to check if agent is online before starting key exchange
    this.eventHandlers.onConnectionStep('signaling');
    const watchAgent = () => {
      this.sendRaw(JSON.stringify({ type: 'watch-agent', agentId }));
      this.eventHandlers.onConnectionStep('waiting-for-agent');
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      watchAgent();
    } else if (this.connectPromise) {
      this.connectPromise.then(watchAgent).catch(() => {
        // WebSocket failed to connect — error already handled by connect()
      });
    }
  }

  /**
   * Disconnect from a specific agent, cleaning up its session.
   */
  disconnectFromAgent(agentId: string): void {
    this.cleanupAgentSession(agentId);
    if (this.activeAgentId === agentId) {
      this.activeAgentId = null;
    }
  }

  /**
   * Stop auto-reconnection attempts without closing the WebSocket.
   * Used when the user manually aborts a connection.
   */
  stopReconnecting(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;
    this.autoReconnect = false;
  }

  /**
   * Set the active agent that send() targets.
   */
  setActiveAgent(agentId: string): void {
    if (this.sessions.has(agentId)) {
      this.activeAgentId = agentId;
    } else {
      console.error(`No session for agent ${agentId}`);
    }
  }

  /**
   * Get the currently active agent ID.
   */
  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  /**
   * Check if a session exists for a given agent ID.
   */
  hasSession(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    return !!session?.keyExchangeComplete;
  }

  /**
   * Get all connected agent IDs.
   */
  getConnectedAgentIds(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([_, s]) => s.keyExchangeComplete)
      .map(([id]) => id);
  }

  // =========================================================================
  // Message handling
  // =========================================================================

  private async handleMessage(rawData: string): Promise<void> {
    try {
      const parsed = JSON.parse(rawData);

      // Check if this is a routed message (has from/to/payload)
      if (parsed.from && parsed.to && 'payload' in parsed) {
        await this.handleRoutedMessage(parsed as RoutedEnvelope);
        return;
      }

      // Handle compressed signaling messages (z = zipped)
      if (parsed.z) {
        const message = JSON.parse(await this.decompress(parsed.z));
        await this.handleSignalingMessage(message);
        return;
      }

      // Handle signaling messages (only specific types from signaling server)
      const signalingTypes = ['peer-connected', 'peer-offline', 'bye', 'error', 'agent-status'];
      if (parsed.type && signalingTypes.includes(parsed.type)) {
        await this.handleSignalingMessage(parsed);
        return;
      }

      // Unrecognized JSON message - log and ignore
      console.warn('Received unrecognized message:', parsed);
    } catch {
      // Not valid JSON - should not happen with routing, but log it
      console.warn('Received non-JSON message on key-based connection');
    }
  }

  /**
   * Handle a routed message: extract the sender agent and process the payload.
   */
  private async handleRoutedMessage(envelope: RoutedEnvelope): Promise<void> {
    // Extract sender agentId from "agent:{agentId}" format
    const fromMatch = envelope.from.match(/^agent:(.+)$/);
    if (!fromMatch) {
      console.warn('Received routed message from unknown sender format:', envelope.from);
      return;
    }

    const agentId = fromMatch[1];
    const session = this.sessions.get(agentId);

    if (!session) {
      console.warn(`Received message from unknown agent: ${agentId}`);
      return;
    }

    // The payload is the actual data to process (key-exchange-ack, encrypted message, etc.)
    await this.handleDataMessage(envelope.payload, session);
  }

  private async handleSignalingMessage(message: { type: string; payload?: unknown }): Promise<void> {
    switch (message.type) {
      case 'agent-status': {
        const { agentId, online } = message.payload as { agentId: string; online: boolean };
        this.eventHandlers.onAgentStatus(agentId, online);
        if (online) {
          const session = this.sessions.get(agentId);
          if (session && !session.keyExchangeComplete) {
            this.initiateKeyExchange(session);
          }
        } else {
          // Agent went offline — reset key exchange so we re-negotiate when it returns
          const session = this.sessions.get(agentId);
          if (session) {
            session.keyExchangeComplete = false;
            session.sessionDEK = null;
            session.keyExchangeRetries = 0;
            if (session.keyExchangeTimeout) {
              clearTimeout(session.keyExchangeTimeout);
              session.keyExchangeTimeout = null;
            }
          }
        }
        break;
      }

      case 'peer-connected':
        console.log('Peer connected signal received');
        break;

      case 'peer-offline':
        this.eventHandlers.onError(new Error('Agent is offline'));
        break;

      case 'bye':
        this.handleDisconnection();
        break;
    }
  }

  // =========================================================================
  // Key exchange
  // =========================================================================

  private initiateKeyExchange(session: AgentSession): void {
    // Clear any existing retry timeout
    if (session.keyExchangeTimeout) {
      clearTimeout(session.keyExchangeTimeout);
      session.keyExchangeTimeout = null;
    }

    this.eventHandlers.onConnectionStep('key-exchange', 1);

    // V2 protocol: generate session DEK and encrypt it for the Agent
    session.sessionDEK = generateSessionDEK();
    const encryptedDEK = encryptDEK(session.sessionDEK, session.agentPublicKey);

    const keyExchangePayload = JSON.stringify({
      type: 'key-exchange',
      version: 2,
      encryptedDEK,
      timestamp: Date.now(),
    });

    // Wrap in routing envelope
    this.sendRouted(session.agentId, keyExchangePayload);

    // Schedule retry with exponential backoff
    this.scheduleKeyExchangeRetry(session);
  }

  private scheduleKeyExchangeRetry(session: AgentSession): void {
    if (session.keyExchangeComplete) return;
    if (session.keyExchangeRetries >= WebSocketClient.MAX_KEY_EXCHANGE_RETRIES) {
      this.eventHandlers.onError(
        new Error(`Key exchange failed after ${WebSocketClient.MAX_KEY_EXCHANGE_RETRIES} attempts for agent ${session.agentId}`)
      );
      return;
    }

    const delay = WebSocketClient.KEY_EXCHANGE_BASE_DELAY * Math.pow(2, session.keyExchangeRetries);
    session.keyExchangeRetries++;

    session.keyExchangeTimeout = setTimeout(() => {
      if (!session.keyExchangeComplete && this.sessions.has(session.agentId)) {
        this.eventHandlers.onConnectionStep('key-exchange', session.keyExchangeRetries + 1);
        console.log(`Retrying key exchange for agent ${session.agentId} (attempt ${session.keyExchangeRetries})`);
        // Regenerate DEK for retry
        session.sessionDEK = generateSessionDEK();
        const encryptedDEK = encryptDEK(session.sessionDEK, session.agentPublicKey);

        const keyExchangePayload = JSON.stringify({
          type: 'key-exchange',
          version: 2,
          encryptedDEK,
          timestamp: Date.now(),
        });

        this.sendRouted(session.agentId, keyExchangePayload);
        this.scheduleKeyExchangeRetry(session);
      }
    }, delay);
  }

  // =========================================================================
  // Data message handling (per-session)
  // =========================================================================

  private async handleDataMessage(data: string, session: AgentSession): Promise<void> {
    try {
      // Handle key exchange (uncompressed JSON)
      if (!session.keyExchangeComplete) {
        try {
          const response = JSON.parse(data);

          // Agent acknowledges with key-exchange-ack
          if (response.type === 'key-exchange-ack' && response.version === 2) {
            session.keyExchangeComplete = true;

            // Cancel any pending retry
            if (session.keyExchangeTimeout) {
              clearTimeout(session.keyExchangeTimeout);
              session.keyExchangeTimeout = null;
            }

            console.log(`Key exchange complete with agent ${session.agentId}`);
            this.eventHandlers.onConnectionStep('handshake');
            this.requestHandshake(session);
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
      if (!session.sessionDEK) {
        console.error('No encryption key available for session');
        return;
      }

      const decrypted = decryptWithSharedSecret(data, session.sessionDEK);
      const decompressed = await this.decompress(decrypted);
      const message = parseMessage(decompressed);

      // Handle handshake response
      if (message.type === 'handshake:ack') {
        const payload = message.payload as HandshakeAckPayload & { license?: License };
        const isPro = payload.license ? verifyLicense(payload.license) : false;
        this.eventHandlers.onConnected(session.agentId, payload.repoPath, isPro, payload.availableRepos, payload.availableCodingPaths, payload.preferences, payload.agentVersion, payload.latestVersion, payload.devBuild, payload.codexModels);
        return;
      }

      this.eventHandlers.onMessage(message);
      // Relay broadcast events to other tabs so their session list indicators stay current.
      // BroadcastChannel doesn't deliver to the sender, so there's no loop risk.
      if (CROSS_TAB_MESSAGE_TYPES.has(message.type)) {
        this.crossTabChannel?.postMessage(message);
      }
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  // =========================================================================
  // Sending messages
  // =========================================================================

  private requestHandshake(session: AgentSession): void {
    this.sendToAgent(session.agentId, {
      id: `handshake-${Date.now()}`,
      type: 'handshake',
      payload: {
        publicKey: encodeBase64(session.keyPair.publicKey),
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Send a Message to the active agent. Encrypts with the active session's DEK
   * and wraps in a routing envelope.
   */
  send(message: Message): void {
    if (!this.activeAgentId) {
      throw new Error('No active agent set');
    }
    this.sendToAgent(this.activeAgentId, message);
  }

  /**
   * Send a Message to a specific agent by ID.
   */
  sendToAgent(agentId: string, message: Message): void {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`No session for agent ${agentId}`);
    }

    if (!session.sessionDEK) {
      throw new Error('No encryption key available — key exchange may not be complete');
    }

    // Compress before encryption for better compression ratio
    const serialized = serializeMessage(message);
    this.compress(serialized).then((compressed) => {
      // Re-check DEK: may have been cleared during async compression (e.g. reconnect)
      if (!session.sessionDEK) return;
      const encrypted = encryptWithSharedSecret(compressed, session.sessionDEK);
      this.sendRouted(agentId, encrypted);
    });
  }

  /**
   * Send a raw payload wrapped in a routing envelope.
   */
  private sendRouted(agentId: string, payload: string): void {
    const envelope: RoutedEnvelope = {
      from: `pwa:${this.connectionId}`,
      to: `agent:${agentId}`,
      payload,
    };
    this.sendRaw(JSON.stringify(envelope));
  }

  private sendRaw(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // =========================================================================
  // Connection lifecycle
  // =========================================================================

  private handleDisconnection(): void {
    // Don't reconnect if this was a manual disconnect
    if (this.isManualDisconnect) {
      this.cleanupAllSessions();
      this.eventHandlers.onDisconnected();
      return;
    }

    // Only attempt reconnect if we were previously connected
    if (this.wasConnected && this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.cleanupAllSessions();
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
      // Reset session key exchange state — we need to re-exchange after reconnect
      for (const session of this.sessions.values()) {
        session.keyExchangeComplete = false;
        session.sessionDEK = null;
        session.keyExchangeRetries = 0;
        session.keyPair = generateKeyPair();
        if (session.keyExchangeTimeout) {
          clearTimeout(session.keyExchangeTimeout);
          session.keyExchangeTimeout = null;
        }
      }

      await this.connect();

      // Re-watch agents and let agent-status trigger key exchange
      for (const session of this.sessions.values()) {
        this.sendRaw(JSON.stringify({ type: 'watch-agent', agentId: session.agentId }));
        this.eventHandlers.onConnectionStep('waiting-for-agent');
      }

      this.reconnectAttempts = 0;
    } catch (error) {
      console.error('Reconnection failed:', error);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        this.eventHandlers.onError(new Error('Failed to reconnect after multiple attempts'));
        this.cleanupAllSessions();
        this.eventHandlers.onDisconnected();
      }
    }
  }

  private cleanupAgentSession(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) {
      if (session.keyExchangeTimeout) {
        clearTimeout(session.keyExchangeTimeout);
        session.keyExchangeTimeout = null;
      }
      session.sessionDEK = null;
      session.keyExchangeComplete = false;
      this.sessions.delete(agentId);
    }
  }

  private cleanupAllSessions(): void {
    for (const agentId of this.sessions.keys()) {
      this.cleanupAgentSession(agentId);
    }
    this.activeAgentId = null;
  }

  /**
   * Close the WebSocket and clean up everything.
   */
  disconnect(): void {
    this.isManualDisconnect = true;
    this.autoReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.cleanupAllSessions();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.eventHandlers.onDisconnected();
  }
}

// Re-export as WebRTCClient for backwards compatibility during migration
export { WebSocketClient as WebRTCClient };
