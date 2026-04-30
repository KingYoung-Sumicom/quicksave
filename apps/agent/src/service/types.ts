// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
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
 * True when this process was launched via the dev-daemon loader
 * (`dev-marker.mjs` sets this before any app code runs). This is the single
 * source of truth for "am I a dev-mode process" — we don't parse BUILD_ID or
 * NODE_ENV, both of which have silently broken dev detection in the past.
 */
const IS_DEV = (globalThis as { __QUICKSAVE_DEV__?: boolean }).__QUICKSAVE_DEV__ === true;

/**
 * Build output content hash, replaced by the bundler at production build time.
 * In dev mode, hashes source file mtimes so the value only changes when code
 * actually changes — avoids spurious daemon restarts.
 */
const _PLACEHOLDER = '__BUILD_ID__';
export const BUILD_ID = IS_DEV ? devBuildId() : _PLACEHOLDER;

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
// get-agent-state / unlock-pairing (C4)
// ---------------------------------------------------------------------------

export type AgentPairState = 'unpaired' | 'paired' | 'closed';

export interface AgentStateResult {
  state: AgentPairState;
  agentId: string;
  publicKey: string;
  signPublicKey: string;
  peerPWAPublicKey: string | null;
  peerPWASignPublicKey: string | null;
  peerCount: number;
  connectionState: 'connected' | 'connecting' | 'disconnected';
}

export interface UnlockPairingResult {
  previousState: AgentPairState;
  state: AgentPairState;
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
  // Any BUILD_ID mismatch means the running daemon's code differs from the
  // CLI's code — restart regardless of dev vs prod. In prod this catches
  // `npm install -g quicksave@newer` replacing an older daemon; in dev it
  // catches source-file edits (BUILD_ID is an mtime hash).
  if (daemon.daemonBuildId !== cli.buildId) {
    return { action: 'restart' };
  }
  return { action: 'ok' };
}

export function isDev(): boolean {
  return IS_DEV;
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
