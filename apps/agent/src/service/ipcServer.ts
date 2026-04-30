// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * IPC server — JSON-RPC 2.0 over newline-delimited Unix domain socket.
 *
 * The daemon creates this server on startup. CLI clients and session workers
 * connect to it as JSON-RPC clients.
 */

import { createServer, type Server, type Socket } from 'net';
import { unlinkSync, chmodSync } from 'fs';
import { EventEmitter } from 'events';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  HelloParams,
  HelloResult,
  PingResult,
  StatusResult,
} from './types.js';
import { IPC_VERSION, BUILD_ID, RpcErrorCode } from './types.js';

// ---------------------------------------------------------------------------
// Client connection wrapper
// ---------------------------------------------------------------------------

export interface IpcClient {
  id: string;
  role?: 'cli' | 'worker';
  sessionId?: string;
  subscribed: boolean;
  socket: Socket;
}

// ---------------------------------------------------------------------------
// Method handler signature
// ---------------------------------------------------------------------------

export type MethodHandler = (
  params: Record<string, unknown>,
  client: IpcClient,
) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// IpcServer
// ---------------------------------------------------------------------------

export class IpcServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Map<string, IpcClient>();
  private methods = new Map<string, MethodHandler>();
  private nextClientId = 1;
  private startedAt: Date;
  private version: string;
  private statusProvider?: () => StatusResult;

  constructor(opts: { version: string }) {
    super();
    this.version = opts.version;
    this.startedAt = new Date();

    // Register built-in methods
    this.registerMethod('hello', (params) => this.handleHello(params as unknown as HelloParams));
    this.registerMethod('ping', () => this.handlePing());
    this.registerMethod('status', () => this.handleStatus());
    this.registerMethod('shutdown', (_params, client) => this.handleShutdown(client));
    this.registerMethod('subscribe-events', (_params, client) => this.handleSubscribe(client));
  }

  /** Register a JSON-RPC method handler. */
  registerMethod(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Set a provider for live status data (wired after AgentConnection starts). */
  setStatusProvider(fn: () => StatusResult): void {
    this.statusProvider = fn;
  }

  /** Start listening on the given Unix socket path. */
  async listen(socketPath: string): Promise<void> {
    // Remove stale socket file if present
    try {
      unlinkSync(socketPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.onConnection(socket));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(socketPath, () => {
        // Set socket permissions to owner-only
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // Best effort — may fail on some systems
        }
        resolve();
      });
    });
  }

  /** Gracefully close the server and all client connections. */
  async close(): Promise<void> {
    // Notify subscribed clients
    this.broadcast({
      jsonrpc: '2.0',
      method: 'event.daemonStatus',
      params: { shutting_down: true },
    });

    // Half-close each client socket: `end()` flushes any buffered writes (e.g.
    // the pending shutdown response) before sending FIN. `destroy()` would
    // drop them, causing the client to reject with "IPC connection closed".
    for (const client of this.clients.values()) {
      if (!client.socket.destroyed) {
        client.socket.end();
      }
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get the number of connected clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Broadcast a JSON-RPC notification to all subscribed CLI clients. */
  broadcast(notification: JsonRpcNotification): void {
    for (const client of this.clients.values()) {
      if (client.subscribed) {
        this.sendMessage(client.socket, notification);
      }
    }
  }

  /** Send a JSON-RPC request to a specific client (for daemon→worker commands). */
  sendRequest(clientId: string, method: string, params: Record<string, unknown>, id: number | string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.sendMessage(client.socket, request);
    return true;
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    const clientId = `c${this.nextClientId++}`;
    const client: IpcClient = {
      id: clientId,
      subscribed: false,
      socket,
    };
    this.clients.set(clientId, client);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          this.handleLine(line, client);
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      this.emit('client-disconnected', client);
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  private async handleLine(line: string, client: IpcClient): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(client.socket, null, RpcErrorCode.PARSE_ERROR, 'Parse error');
      return;
    }

    // Ignore responses (we don't expect them from clients in this direction, but workers may ack)
    if ('result' in msg || 'error' in msg) {
      this.emit('response', msg, client);
      return;
    }

    // Must have a method
    if (!('method' in msg) || typeof msg.method !== 'string') {
      this.sendError(client.socket, (msg as any).id ?? null, RpcErrorCode.INVALID_REQUEST, 'Invalid request');
      return;
    }

    const handler = this.methods.get(msg.method);
    if (!handler) {
      if ('id' in msg && msg.id != null) {
        this.sendError(client.socket, msg.id, RpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      }
      return;
    }

    const params = ('params' in msg ? msg.params : {}) as Record<string, unknown>;

    try {
      const result = await handler(params, client);
      // Only send response if it's a request (has id), not a notification
      if ('id' in msg && msg.id != null) {
        const response: JsonRpcResponse = { jsonrpc: '2.0', id: msg.id, result };
        this.sendMessage(client.socket, response);
      }
    } catch (err: any) {
      if ('id' in msg && msg.id != null) {
        const code = err.rpcCode ?? RpcErrorCode.INVALID_PARAMS;
        this.sendError(client.socket, msg.id, code, err.message ?? 'Internal error');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Built-in method handlers
  // -----------------------------------------------------------------------

  private handleHello(_params: HelloParams): HelloResult {
    // hello always succeeds — client decides based on version fields
    return {
      daemonVersion: this.version,
      daemonIpcVersion: IPC_VERSION,
      daemonBuildId: BUILD_ID,
      daemonPid: process.pid,
    };
  }

  private handlePing(): PingResult {
    const uptimeMs = Date.now() - this.startedAt.getTime();
    return {
      version: this.version,
      ipcVersion: IPC_VERSION,
      buildId: BUILD_ID,
      uptime: Math.floor(uptimeMs / 1000),
    };
  }

  private handleStatus(): StatusResult {
    if (this.statusProvider) return this.statusProvider();
    const uptimeMs = Date.now() - this.startedAt.getTime();
    return {
      version: this.version,
      pid: process.pid,
      uptime: Math.floor(uptimeMs / 1000),
      connectionState: 'disconnected',
      peerCount: 0,
      activeSessions: 0,
      managedRepos: 0,
    };
  }

  private handleShutdown(_client: IpcClient): { ok: true } {
    // Defer to setImmediate (not process.nextTick): nextTick fires before the
    // I/O poll phase, so the {ok:true} response `handleLine` is about to write
    // wouldn't reach the client before `close()` destroys the socket.
    setImmediate(() => this.emit('shutdown-requested'));
    return { ok: true };
  }

  private handleSubscribe(client: IpcClient): { subscribed: true } {
    client.subscribed = true;
    return { subscribed: true };
  }

  // -----------------------------------------------------------------------
  // Wire helpers
  // -----------------------------------------------------------------------

  private sendMessage(socket: Socket, msg: JsonRpcMessage): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private sendError(socket: Socket, id: number | string | null, code: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message },
    };
    this.sendMessage(socket, response);
  }
}
