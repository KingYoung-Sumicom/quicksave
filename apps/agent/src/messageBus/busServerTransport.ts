// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createMessage, type Message } from '@sumicom/quicksave-shared';
import type {
  ClientFrame,
  PeerId,
  ServerFrame,
  ServerTransport,
} from '@sumicom/quicksave-message-bus';
import type { AgentConnection } from '../connection/connection.js';

/**
 * Server-side adapter exposing {@link AgentConnection} as a
 * {@link ServerTransport} for {@link MessageBusServer}.
 *
 * - Inbound: filters incoming `Message` objects for `type === 'bus:frame'`
 *   and forwards their payload to the bus as a {@link ClientFrame}.
 * - Outbound: wraps outgoing {@link ServerFrame}s in a `bus:frame`
 *   {@link Message} envelope and hands them to `AgentConnection.send()`
 *   addressed to the peer.
 * - Lifecycle: mirrors `connected` / `disconnected` events from the connection.
 *
 * This adapter does not own the connection; it attaches listeners only.
 * Multiple adapters may coexist (e.g. during migration), but each will
 * receive every inbound message and must filter by type.
 */
export class BusServerTransport implements ServerTransport {
  private frameHandlers: Array<(peer: PeerId, frame: ClientFrame) => void> = [];
  private connectHandlers: Array<(peer: PeerId) => void> = [];
  private disconnectHandlers: Array<(peer: PeerId) => void> = [];

  constructor(private connection: AgentConnection) {
    connection.on('message', (msg: Message, peer: string) => {
      if (msg.type !== 'bus:frame') return;
      const frame = msg.payload as ClientFrame;
      for (const h of this.frameHandlers) h(peer, frame);
    });
    connection.on('connected', (peer: string) => {
      for (const h of this.connectHandlers) h(peer);
    });
    connection.on('disconnected', (peer: string) => {
      for (const h of this.disconnectHandlers) h(peer);
    });
  }

  send(peer: PeerId, frame: ServerFrame): void {
    const envelope = createMessage('bus:frame', frame);
    this.connection.send(envelope, peer);
  }

  onFrame(handler: (peer: PeerId, frame: ClientFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  onPeerConnected(handler: (peer: PeerId) => void): void {
    this.connectHandlers.push(handler);
  }

  onPeerDisconnected(handler: (peer: PeerId) => void): void {
    this.disconnectHandlers.push(handler);
  }
}
