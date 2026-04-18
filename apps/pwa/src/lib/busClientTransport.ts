import { createMessage, type Message } from '@sumicom/quicksave-shared';
import type {
  ClientFrame,
  ClientTransport,
  ServerFrame,
} from '@sumicom/quicksave-message-bus';
import type { WebSocketClient } from './websocket.js';

/**
 * Client-side adapter exposing {@link WebSocketClient} as a
 * {@link ClientTransport} for {@link MessageBusClient}.
 *
 * Integration model:
 *  - The adapter is fed incoming {@link Message}s via {@link notifyMessage}
 *    rather than registering its own handler on the shared client. The host
 *    (e.g. the `useClaudeOperations` hook) calls `notifyMessage` from its
 *    existing `onMessage` pump; if the message is a `bus:frame`, the adapter
 *    consumes it and returns `true`, otherwise the host routes it as usual.
 *  - Connected / disconnected / error state is fed through
 *    {@link notifyConnected}, {@link notifyDisconnected}, which mirror the
 *    events the hook already observes.
 *  - `send()` wraps the outgoing {@link ClientFrame} in a `bus:frame`
 *    envelope and calls `WebSocketClient.send()`.
 *
 * Rationale: the existing `WebSocketClient` uses a single-handler callback
 * model (`ConnectionEventHandler.onMessage`). Adding a second consumer would
 * require invasive changes to the client; letting the adapter be driven
 * externally keeps the change surface tight for Phase 2.
 */
export class BusClientTransport implements ClientTransport {
  private frameHandlers: Array<(frame: ServerFrame) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private connected = false;

  constructor(private client: WebSocketClient) {}

  /**
   * Feed an incoming Message observed by the host's `onMessage` pump.
   * Returns `true` if the message was a `bus:frame` and was consumed by
   * the adapter, `false` if the host should handle it normally.
   */
  notifyMessage(message: Message): boolean {
    if (message.type !== 'bus:frame') return false;
    const frame = message.payload as ServerFrame;
    for (const h of this.frameHandlers) h(frame);
    return true;
  }

  /**
   * Signal that the underlying link is ready (post key-exchange).
   * Fires the ClientTransport `connected` event once per transition.
   */
  notifyConnected(): void {
    if (this.connected) return;
    this.connected = true;
    for (const h of this.connectHandlers) h();
  }

  /** Signal that the underlying link has gone down. Idempotent. */
  notifyDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const h of this.disconnectHandlers) h();
  }

  send(frame: ClientFrame): void {
    const envelope = createMessage('bus:frame', frame);
    this.client.send(envelope);
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
