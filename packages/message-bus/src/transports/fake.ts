// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type {
  ClientTransport,
  PeerId,
  ServerTransport,
} from '../transport.js';
import type { ClientFrame, ServerFrame } from '../types.js';

/**
 * In-memory transport pair for testing. Supports multiple clients connecting
 * to a single server. Messages are delivered via `queueMicrotask` to surface
 * any ordering assumptions.
 */
export class FakePipe {
  readonly server: FakeServerTransport;
  private clients = new Map<PeerId, FakeClientTransport>();
  private idCounter = 0;

  constructor() {
    this.server = new FakeServerTransport();
  }

  /** Create a new client connected to the shared server. */
  createClient(): FakeClientTransport {
    const peerId = `peer-${++this.idCounter}`;
    const client = new FakeClientTransport(peerId, this);
    this.clients.set(peerId, client);
    return client;
  }

  /** Used internally by clients to deliver frames to the server. */
  _deliverToServer(peer: PeerId, frame: ClientFrame): void {
    queueMicrotask(() => this.server._receive(peer, frame));
  }

  /** Used internally by the server to deliver frames to a client. */
  _deliverToClient(peer: PeerId, frame: ServerFrame): void {
    const client = this.clients.get(peer);
    if (!client) return;
    queueMicrotask(() => client._receive(frame));
  }

  _notifyServerOfConnect(peer: PeerId): void {
    queueMicrotask(() => this.server._peerConnected(peer));
  }

  _notifyServerOfDisconnect(peer: PeerId): void {
    this.clients.delete(peer);
    queueMicrotask(() => this.server._peerDisconnected(peer));
  }
}

export class FakeServerTransport implements ServerTransport {
  private frameHandlers: Array<(peer: PeerId, frame: ClientFrame) => void> = [];
  private connectHandlers: Array<(peer: PeerId) => void> = [];
  private disconnectHandlers: Array<(peer: PeerId) => void> = [];
  private pipes = new Map<PeerId, FakePipe>();

  send(peer: PeerId, frame: ServerFrame): void {
    const pipe = this.pipes.get(peer);
    if (!pipe) return;
    pipe._deliverToClient(peer, frame);
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

  _registerPeer(peer: PeerId, pipe: FakePipe): void {
    this.pipes.set(peer, pipe);
  }

  _receive(peer: PeerId, frame: ClientFrame): void {
    for (const handler of this.frameHandlers) handler(peer, frame);
  }

  _peerConnected(peer: PeerId): void {
    for (const handler of this.connectHandlers) handler(peer);
  }

  _peerDisconnected(peer: PeerId): void {
    this.pipes.delete(peer);
    for (const handler of this.disconnectHandlers) handler(peer);
  }
}

export class FakeClientTransport implements ClientTransport {
  private frameHandlers: Array<(frame: ServerFrame) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private reestablishedHandlers: Array<() => void> = [];
  private connected = false;

  constructor(
    private peerId: PeerId,
    private pipe: FakePipe,
  ) {}

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.pipe.server._registerPeer(this.peerId, this.pipe);
    this.pipe._notifyServerOfConnect(this.peerId);
    // Fire local handlers on next microtask so subscribers can wire up first.
    // Each `connect()` represents a fresh upstream session, so fire
    // onReestablished alongside onConnected to drive sub re-send.
    queueMicrotask(() => {
      for (const handler of this.connectHandlers) handler();
      for (const handler of this.reestablishedHandlers) handler();
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.pipe._notifyServerOfDisconnect(this.peerId);
    for (const handler of this.disconnectHandlers) handler();
  }

  send(frame: ClientFrame): void {
    if (!this.connected) {
      throw new Error('FakeClientTransport: not connected');
    }
    this.pipe._deliverToServer(this.peerId, frame);
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

  onReestablished(handler: () => void): void {
    this.reestablishedHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  _receive(frame: ServerFrame): void {
    for (const handler of this.frameHandlers) handler(frame);
  }
}
