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
 */
export interface ClientTransport {
  send(frame: ClientFrame): void;
  onFrame(handler: (frame: ServerFrame) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: () => void): void;
  isConnected(): boolean;
}
