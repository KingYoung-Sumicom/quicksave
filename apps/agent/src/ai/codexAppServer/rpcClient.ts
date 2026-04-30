// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { RequestId } from './schema/index.js';

/**
 * JSON-RPC 2.0 wire envelopes. The codex app-server uses these on stdio
 * (one message per line, JSONL framing).
 */
export type WireRequest = {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: unknown;
};

export type WireSuccessResponse = {
  jsonrpc: '2.0';
  id: RequestId;
  result: unknown;
};

export type WireErrorResponse = {
  jsonrpc: '2.0';
  id: RequestId;
  error: { code: number; message: string; data?: unknown };
};

export type WireResponse = WireSuccessResponse | WireErrorResponse;

export type WireNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type WireMessage = WireRequest | WireResponse | WireNotification;

/**
 * Transport abstraction so the RPC client can be tested without a real
 * child process. Implementations: `StdioTransport` (real codex
 * app-server child) and `InMemoryTransport` (tests).
 */
export interface RpcTransport {
  /** Encode the message and write it to the wire. Resolves once the line
   * has been handed to the OS write buffer. */
  send(message: WireMessage): Promise<void>;
  /** Subscribe to inbound parsed messages. Returns an unsubscribe fn. */
  onMessage(listener: (message: WireMessage) => void): () => void;
  /** Subscribe to transport closure (process exit, broken pipe, etc.).
   * `reason` is `null` on clean close. Returns an unsubscribe fn. */
  onClose(listener: (reason: Error | null) => void): () => void;
  /** Close the transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * JSON-RPC error wrapping a `WireErrorResponse.error`. Thrown by
 * `request()` when the server returns an error response.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(method: string, error: { code: number; message: string; data?: unknown }) {
    super(`${method}: ${error.message} (code ${error.code})`);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/**
 * Thrown when a request is in flight at the moment the transport closes.
 */
export class RpcTransportClosedError extends Error {
  constructor(method: string, reason: Error | null) {
    super(`transport closed before ${method} response${reason ? `: ${reason.message}` : ''}`);
    this.name = 'RpcTransportClosedError';
  }
}

export type ServerRequestHandler = (request: {
  id: RequestId;
  method: string;
  params: unknown;
}) => Promise<unknown>;

/**
 * JSON-RPC 2.0 client speaking the codex `app-server` v2 protocol.
 *
 * Owns:
 * - request/response correlation via numeric ids,
 * - notification dispatch to subscribers,
 * - server→client request handling via a single registered handler.
 *
 * Does NOT own:
 * - process spawning (that's `processManager.ts`),
 * - protocol-level handshake (that's the provider).
 */
export class CodexRpcClient {
  private readonly transport: RpcTransport;
  private nextId = 1;
  private readonly pending = new Map<
    RequestId,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();
  private readonly notificationListeners = new Set<
    (notification: { method: string; params: unknown }) => void
  >();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private closed = false;
  private closeReason: Error | null = null;
  private readonly unsubMessage: () => void;
  private readonly unsubClose: () => void;

  constructor(transport: RpcTransport) {
    this.transport = transport;
    this.unsubMessage = transport.onMessage((m) => this.handleMessage(m));
    this.unsubClose = transport.onClose((reason) => this.handleClose(reason));
  }

  /** Send a JSON-RPC request and wait for its response. Rejects with
   * `RpcError` on a server error response, or
   * `RpcTransportClosedError` if the transport closes first. */
  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) {
      throw new RpcTransportClosedError(method, this.closeReason);
    }
    const id = this.nextId++;
    const promise = new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    try {
      await this.transport.send({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    return promise;
  }

  /** Send a JSON-RPC notification (no response expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new RpcTransportClosedError(method, this.closeReason);
    }
    await this.transport.send({ jsonrpc: '2.0', method, params });
  }

  /** Subscribe to inbound notifications. Returns an unsubscribe fn. */
  onNotification(
    listener: (notification: { method: string; params: unknown }) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Register the (single) handler for inbound server→client requests.
   * Setting this to null returns errors to any subsequent server request.
   * Re-registering replaces the previous handler. */
  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  /** Close the transport. Pending requests reject with
   * `RpcTransportClosedError`. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClose(null);
    await this.transport.close();
  }

  /** True once the transport has closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  private handleMessage(message: WireMessage): void {
    if (typeof message !== 'object' || message === null) return;
    // Note: codex app-server omits the `jsonrpc: "2.0"` envelope field on
    // responses (verified against CLI 0.125.0 — the standalone shape is
    // `{id, result}` / `{id, error}` / `{method, params}`). We do NOT
    // require it; we route by the presence of `id` and `method`.
    const m = message as Record<string, unknown>;
    if ('id' in m && 'method' in m) {
      void this.handleServerRequest(m as unknown as WireRequest);
    } else if ('id' in m && ('result' in m || 'error' in m)) {
      this.handleResponse(m as unknown as WireResponse);
    } else if ('method' in m && !('id' in m)) {
      this.handleNotification(m as unknown as WireNotification);
    }
  }

  private handleResponse(response: WireResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if ('error' in response) {
      entry.reject(new RpcError(entry.method, response.error));
    } else {
      entry.resolve(response.result);
    }
  }

  private handleNotification(notification: WireNotification): void {
    const payload = { method: notification.method, params: notification.params ?? null };
    for (const l of this.notificationListeners) {
      try {
        l(payload);
      } catch {
        // listeners must not throw; swallow to keep the dispatch loop alive.
      }
    }
  }

  private async handleServerRequest(request: WireRequest): Promise<void> {
    const handler = this.serverRequestHandler;
    if (!handler) {
      await this.respondError(request.id, request.method, {
        code: -32601,
        message: `no handler registered for server-initiated request ${request.method}`,
      });
      return;
    }
    try {
      const result = await handler({
        id: request.id,
        method: request.method,
        params: request.params ?? null,
      });
      await this.transport.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.respondError(request.id, request.method, {
        code: -32000,
        message,
      });
    }
  }

  private async respondError(
    id: RequestId,
    _method: string,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    try {
      await this.transport.send({ jsonrpc: '2.0', id, error });
    } catch {
      // best-effort; transport is probably already gone.
    }
  }

  private handleClose(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.unsubMessage();
    this.unsubClose();
    for (const [, entry] of this.pending) {
      entry.reject(new RpcTransportClosedError(entry.method, reason));
    }
    this.pending.clear();
    this.notificationListeners.clear();
    this.serverRequestHandler = null;
  }
}

// -----------------------------------------------------------------------------
// In-memory transport for tests
// -----------------------------------------------------------------------------

/**
 * Test-only transport. The two paired instances behave like a duplex
 * pipe — sending on one delivers on the other. Use `InMemoryTransport.pair()`.
 */
export class InMemoryTransport implements RpcTransport {
  private readonly messageListeners = new Set<(m: WireMessage) => void>();
  private readonly closeListeners = new Set<(reason: Error | null) => void>();
  private peer: InMemoryTransport | null = null;
  private closed = false;

  static pair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async send(message: WireMessage): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    const peer = this.peer;
    if (!peer || peer.closed) throw new Error('peer closed');
    // Defer delivery so callers that await send() complete first; matches
    // the asynchrony of a real stdio pipe.
    queueMicrotask(() => peer.deliver(message));
  }

  onMessage(listener: (message: WireMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) l(null);
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      for (const l of this.peer.closeListeners) l(null);
    }
  }

  /** Test-only: simulate a transport-level failure. Propagates to the
   * paired peer with the same reason so both sides see the disconnect. */
  failClose(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) l(reason);
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      for (const l of this.peer.closeListeners) l(reason);
    }
  }

  private deliver(message: WireMessage): void {
    if (this.closed) return;
    for (const l of this.messageListeners) {
      try {
        l(message);
      } catch {
        // swallow; same rule as the real client.
      }
    }
  }
}
