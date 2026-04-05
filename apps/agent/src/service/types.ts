/**
 * Service daemon IPC protocol types.
 *
 * Wire format: JSON-RPC 2.0 over newline-delimited Unix domain socket.
 * Each JSON-RPC message is terminated by '\n'.
 */

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/** Bumped only on IPC protocol breaking changes. */
export const IPC_VERSION = 1;

/**
 * Build output content hash, injected at build time.
 * In dev mode, used to detect stale daemons running old code.
 * Falls back to "dev" if not replaced by the bundler.
 */
export const BUILD_ID = '__BUILD_ID__';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const RpcErrorCode = {
  // Standard JSON-RPC 2.0
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,

  // Application-specific
  SESSION_NOT_FOUND: -32002,
  SESSION_NOT_ACTIVE: -32003,
  WORKER_DISCONNECTED: -32004,
  PERMISSION_TIMEOUT: -32005,
  DAEMON_SHUTTING_DOWN: -32006,
} as const;

// ---------------------------------------------------------------------------
// hello handshake
// ---------------------------------------------------------------------------

export interface HelloParams {
  role: 'cli' | 'worker';
  version: string;
  ipcVersion: number;
  buildId: string;
  sessionId?: string;
  workerPid?: number;
}

export interface HelloResult {
  daemonVersion: string;
  daemonIpcVersion: number;
  daemonBuildId: string;
  daemonPid: number;
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

export interface PingResult {
  version: string;
  ipcVersion: number;
  buildId: string;
  uptime: number;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusResult {
  version: string;
  pid: number;
  uptime: number;
  connectionState: 'connected' | 'connecting' | 'disconnected';
  peerCount: number;
  activeSessions: number;
  managedRepos: number;
}

// ---------------------------------------------------------------------------
// service.json shape
// ---------------------------------------------------------------------------

export interface ServiceState {
  pid: number;
  version: string;
  ipcVersion: number;
  buildId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  socketPath: string;
  agentId: string;
  publicKey: string;
  signalingServer: string;
  connectionState: 'connected' | 'connecting' | 'disconnected';
  peerCount: number;
}

// ---------------------------------------------------------------------------
// get-pairing-info
// ---------------------------------------------------------------------------

export interface PairingInfoResult {
  agentId: string;
  publicKey: string;
  pairingUrl: string;
  connectionState: 'connected' | 'connecting' | 'disconnected';
  peerCount: number;
}

// ---------------------------------------------------------------------------
// repo management
// ---------------------------------------------------------------------------

export interface RepoInfo {
  path: string;
  name: string;
  valid: boolean;
  currentBranch?: string;
}

// ---------------------------------------------------------------------------
// ensureDaemon helper types
// ---------------------------------------------------------------------------

export type DaemonCheckResult =
  | { action: 'restart' }
  | { action: 'warn_outdated' }
  | { action: 'ok' };

export function shouldRestartDaemon(
  daemon: HelloResult,
  cli: { ipcVersion: number; buildId: string },
): DaemonCheckResult {
  if (daemon.daemonIpcVersion !== cli.ipcVersion) {
    return daemon.daemonIpcVersion < cli.ipcVersion
      ? { action: 'restart' }
      : { action: 'warn_outdated' };
  }
  if (isDev() && daemon.daemonBuildId !== cli.buildId) {
    return { action: 'restart' };
  }
  return { action: 'ok' };
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}
