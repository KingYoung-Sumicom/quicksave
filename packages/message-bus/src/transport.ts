// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ClientFrame, ServerFrame } from './types.js';

/** Identifier for a connected client from the server's perspective. */
export type PeerId = string;

/**
 * Server-side transport. Frames are addressed per-peer so the server can
 * deliver snapshots/updates to specific subscribers.
 *
 * Transports are responsible for wrapping the frame JSON in whatever envelope
 * the underlying wire needs (encryption, routing metadata, etc.) and for
 * emitting `peer-connected` / `peer-disconnected` so the server can track
 * liveness and drop subscriptions.
 */
export interface ServerTransport {
  send(peer: PeerId, frame: ServerFrame): void;
  onFrame(handler: (peer: PeerId, frame: ClientFrame) => void): void;
  onPeerConnected(handler: (peer: PeerId) => void): void;
  onPeerDisconnected(handler: (peer: PeerId) => void): void;
}

/**
 * Client-side transport. A client has exactly one upstream, so frames are
 * not addressed.
 *
 * Two distinct lifecycle signals matter for clients:
 *
 *  - `onConnected` / `onDisconnected` track whether the transport is
 *    *currently up* — used to gate sends and reject in-flight commands. They
 *    fire on transport-level state transitions and should be idempotent
 *    (no-op when already in the target state).
 *
 *  - `onReestablished` fires whenever a fresh upstream session has just been
 *    established at the application protocol level (e.g. a successful
 *    handshake-ack), even if the transport's own connected flag never
 *    transitioned. This separation matters because subscription state on the
 *    server side is wiped per-peer on disconnect; if the underlying transport
 *    masks a brief blip from its observers (to keep in-flight commands and
 *    streaming UI alive), the bus client must still re-send `sub` frames or
 *    its subscriptions will silently die. A transport that never masks blips
 *    can fire `onReestablished` together with each `onConnected` and the
 *    semantics work out the same.
 */
export interface ClientTransport {
  send(frame: ClientFrame): void;
  onFrame(handler: (frame: ServerFrame) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: () => void): void;
  onReestablished(handler: () => void): void;
  isConnected(): boolean;
}
