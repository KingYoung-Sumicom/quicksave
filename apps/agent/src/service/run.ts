/**
 * Daemon entrypoint — `quicksave service run`.
 *
 * Boot sequence:
 * 1. Acquire singleton lock.
 * 2. Start IPC server on Unix socket.
 * 3. Load config.
 * 4. (Later) Start AgentConnection.
 * 5. Persist ready state to service.json.
 * 6. Run heartbeat loop.
 */

import { getOrCreateConfig } from '../config.js';
import { IpcServer } from './ipcServer.js';
import {
  acquireLock,
  ensureDirectories,
  getSocketPath,
  cleanStaleRuntime,
} from './singleton.js';
import { writeServiceState, removeServiceState } from './stateStore.js';
import { IPC_VERSION, BUILD_ID } from './types.js';
import type { ServiceState } from './types.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PACKAGE_VERSION = '0.4.0';

export async function runDaemon(): Promise<void> {
  ensureDirectories();

  // 1. Acquire singleton lock
  const releaseLock = acquireLock();
  if (!releaseLock) {
    console.error('Another daemon is already running. Use `quicksave service status` to check.');
    process.exit(1);
  }

  const socketPath = getSocketPath();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  // 2. Start IPC server
  const ipcServer = new IpcServer({ version: PACKAGE_VERSION });

  try {
    await ipcServer.listen(socketPath);
  } catch (err) {
    console.error('Failed to start IPC server:', err);
    releaseLock();
    process.exit(1);
  }

  // 3. Load config
  const config = getOrCreateConfig('wss://signal.quicksave.dev');

  // 5. Persist ready state
  const startedAt = new Date().toISOString();
  const serviceState: ServiceState = {
    pid: process.pid,
    version: PACKAGE_VERSION,
    ipcVersion: IPC_VERSION,
    buildId: BUILD_ID,
    startedAt,
    lastHeartbeatAt: startedAt,
    socketPath,
    agentId: config.agentId,
    publicKey: config.keyPair.publicKey,
    signalingServer: config.signalingServer,
    connectionState: 'disconnected',
    peerCount: 0,
  };
  writeServiceState(serviceState);

  // 6. Heartbeat loop
  heartbeatTimer = setInterval(() => {
    serviceState.lastHeartbeatAt = new Date().toISOString();
    writeServiceState(serviceState);
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`Quicksave daemon started (pid: ${process.pid})`);
  console.log(`  IPC socket: ${socketPath}`);
  console.log(`  Agent ID:   ${config.agentId}`);

  // Shutdown handler
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('Daemon shutting down...');

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    await ipcServer.close();
    removeServiceState();
    cleanStaleRuntime();
    releaseLock();

    process.exit(0);
  };

  ipcServer.on('shutdown-requested', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
