/**
 * Service daemon IPC protocol types.
 *
 * Wire format: JSON-RPC 2.0 over newline-delimited Unix domain socket.
 * Each JSON-RPC message is terminated by '\n'.
 */

import { createHash } from 'crypto';
import { readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/** Bumped only on IPC protocol breaking changes. */
export const IPC_VERSION = 1;

/**
 * Build output content hash, replaced by the bundler at production build time.
 * In dev mode (placeholder unreplaced), hashes source file mtimes so the
 * value only changes when code actually changes — avoids spurious daemon restarts.
 */
const _PLACEHOLDER = '__BUILD_ID__';
export const BUILD_ID = _PLACEHOLDER === '__BUILD' + '_ID__'
  ? devBuildId()
  : _PLACEHOLDER;

function devBuildId(): string {
  try {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const hash = createHash('md5');
    (function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) hash.update(`${p}:${statSync(p).mtimeMs}`);
      }
    })(srcDir);
    return 'dev-' + hash.digest('hex').slice(0, 12);
  } catch {
    return 'dev';
  }
}

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
  signPublicKey: string;
  pairingUrl: string;
  connectionState: 'connected' | 'connecting' | 'disconnected';
  peerCount: number;
}

// ---------------------------------------------------------------------------
// debug introspection
// ---------------------------------------------------------------------------

export interface DebugResult {
  pid: number;
  uptime: number;
  peers: Array<{
    address: string;
    connectedAt: number;
    topics: string[];
  }>;
  subscriptions: Record<string, string[]>;
  pendingInputs: Array<{
    requestId: string;
    sessionId: string;
    toolName?: string;
    agentId?: string;
    inputType: string;
  }>;
  activeSessions: Array<{
    sessionId: string;
    cwd: string;
    isStreaming: boolean;
    hasPendingInput: boolean;
    permissionMode: string;
  }>;
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
  return BUILD_ID.startsWith('dev-') || process.env.NODE_ENV === 'development';
}

/**
 * Debug CLI commands are enabled by default in dev mode.
 * In production builds, set QUICKSAVE_DEBUG=1 to enable.
 */
export function isDebugEnabled(): boolean {
  if (process.env.QUICKSAVE_DEBUG === '1') return true;
  if (process.env.QUICKSAVE_DEBUG === '0') return false;
  return isDev();
}
