import { createMessage, type Message } from '@sumicom/quicksave-shared';
import type {
  ClientFrame,
  ClientTransport,
  ServerFrame,
} from '@sumicom/quicksave-message-bus';
import type { WebSocketClient } from './websocket.js';

/**
 * Per-agent adapter exposing a single agent's {@link WebSocketClient} session
 * as a {@link ClientTransport} for {@link MessageBusClient}.
 *
 * Each instance is bound to one `agentId` so multi-agent mode can run one
 * `MessageBusClient` per connected agent. The adapter:
 *  - Sends via `WebSocketClient.sendToAgent(agentId, …)` — independent of the
 *    client's shared `activeAgentId`, so commands from agent A don't get
 *    misrouted if the UI has activated agent B.
 *  - Consumes incoming `bus:frame` envelopes only when the source agentId
 *    matches, letting the host fan a single `onMessage` stream into
 *    per-agent transports.
 *  - Receives connect/disconnect signals from the host (via
 *    {@link notifyConnected} / {@link notifyDisconnected}), mirroring the
 *    events the host already observes on the shared client.
 */
export class BusClientTransport implements ClientTransport {
  private frameHandlers: Array<(frame: ServerFrame) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private connected = false;

  constructor(private client: WebSocketClient, private agentId: string) {}

  /**
   * Feed an incoming Message observed by the host's `onMessage` pump. The
   * host knows which agent the message came from; the adapter drops frames
   * from other agents so each bus instance sees only its own traffic.
   * Returns `true` if the message was consumed.
   */
  notifyMessage(message: Message, fromAgentId: string): boolean {
    if (fromAgentId !== this.agentId) return false;
    if (message.type !== 'bus:frame') return false;
    const frame = message.payload as ServerFrame;
    for (const h of this.frameHandlers) h(frame);
    return true;
  }

  /**
   * Signal that this agent's link is ready (post key-exchange).
   * Fires the ClientTransport `connected` event once per transition.
   */
  notifyConnected(): void {
    if (this.connected) return;
    this.connected = true;
    for (const h of this.connectHandlers) h();
  }

  /** Signal that this agent's link has gone down. Idempotent. */
  notifyDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const h of this.disconnectHandlers) h();
  }

  send(frame: ClientFrame): void {
    const envelope = createMessage('bus:frame', frame);
    this.client.sendToAgent(this.agentId, envelope);
  }

  onFrame(handler: (frame: ServerFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  onConnected(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }
}
