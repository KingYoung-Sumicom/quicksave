/**
 * Daemon entrypoint — `quicksave service run`.
 *
 * Boot sequence:
 * 1. Acquire singleton lock.
 * 2. Start IPC server on Unix socket.
 * 3. Load config and managed repos.
 * 4. Start AgentConnection (signaling + message handler).
 * 5. Persist ready state to service.json.
 * 6. Run heartbeat loop.
 */

import { basename } from 'path';
import { hostname } from 'os';
import { getOrCreateConfig, getManagedRepos, getManagedCodingPaths, addManagedRepo, removeManagedRepo } from '../config.js';
import { AgentConnection } from '../connection/connection.js';
import { MessageHandler } from '../handlers/messageHandler.js';
import { GitOperations } from '../git/operations.js';
import { IpcServer } from './ipcServer.js';
import {
  acquireLock,
  ensureDirectories,
  getSocketPath,
  cleanStaleRuntime,
} from './singleton.js';
import { writeServiceState, removeServiceState } from './stateStore.js';
import { IPC_VERSION, BUILD_ID } from './types.js';
import type { ServiceState, StatusResult, PairingInfoResult, RepoInfo } from './types.js';
import { createMessage, type Message, type Repository } from '@sumicom/quicksave-shared';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PACKAGE_VERSION = '0.4.0';

export async function runDaemon(): Promise<void> {
  ensureDirectories();

  // Prevent unhandled rejections from silently killing the daemon
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in daemon:', reason);
  });

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

  // 3. Load config and managed repos
  const config = getOrCreateConfig('wss://signal.quicksave.dev');

  const repoPaths = getManagedRepos();
  const codingPaths = getManagedCodingPaths();

  const validRepos = await validateRepos(repoPaths);
  console.log(`Managed repos: ${validRepos.length} valid of ${repoPaths.length} configured`);

  // 4. Start AgentConnection
  const connection = new AgentConnection({
    signalingServer: config.signalingServer,
    agentId: config.agentId,
    keyPair: config.keyPair,
  });

  const messageHandler = new MessageHandler(validRepos, config.license, codingPaths);

  // Pub/sub: ClaudeCodeService emits events → broadcast to all connected PWA peers
  const claudeService = messageHandler.getClaudeService();
  claudeService.on('stream', (event) => {
    console.log(`[pub/sub] stream event=${event.eventType} session=${event.sessionId} peers=${connection.getPeerCount()}`);
    connection.broadcast(createMessage('claude:stream', event));
  });
  claudeService.on('stream:end', (result) => {
    console.log(`[pub/sub] stream:end session=${result.sessionId} success=${result.success} peers=${connection.getPeerCount()}`);
    connection.broadcast(createMessage('claude:stream:end', result));
  });
  claudeService.on('user-input-request', (request) => {
    console.log(`[pub/sub] user-input-request requestId=${request.requestId} toolName=${request.toolName} peers=${connection.getPeerCount()}`);
    connection.broadcast(createMessage('claude:user-input-request', request));
  });
  claudeService.on('user-input-resolved', (info) => {
    console.log(`[pub/sub] user-input-resolved requestId=${info.requestId} peers=${connection.getPeerCount()}`);
    connection.broadcast(createMessage('claude:user-input-resolved', info));
  });
  claudeService.on('session-updated', (info) => {
    console.log(`[pub/sub] session-updated session=${info.sessionId} active=${info.isActive} streaming=${info.isStreaming} pending=${info.hasPendingInput}`);
    connection.broadcast(createMessage('claude:session-updated', info));
  });

  // Wire: incoming PWA messages → MessageHandler → response back to PWA
  connection.on('message', async (message: Message, peerAddress: string) => {
    try {
      const response = await messageHandler.handleMessage(message, peerAddress);
      connection.send(response, peerAddress);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  });

  // 5. Register IPC methods and status provider BEFORE writing service state,
  //    so methods are available as soon as clients can discover the daemon.
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

  ipcServer.setStatusProvider((): StatusResult => {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    return {
      version: PACKAGE_VERSION,
      pid: process.pid,
      uptime: Math.floor(uptimeMs / 1000),
      connectionState: serviceState.connectionState,
      peerCount: connection.getPeerCount(),
      activeSessions: messageHandler.getActiveSessionCount(),
      managedRepos: getManagedRepos().length,
    };
  });

  registerDaemonMethods(ipcServer, connection, messageHandler, config);

  // Wire peer events
  connection.on('connected', (peerAddress: string) => {
    const peerKey = peerAddress.replace('pwa:', '');
    console.log(`+ PWA connected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} peers)`);
    serviceState.peerCount = connection.getPeerCount();
    serviceState.connectionState = 'connected';
    writeServiceState(serviceState);
    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.peerConnected',
      params: { peerId: peerKey.slice(0, 12), peerCount: connection.getPeerCount() },
    });
  });

  connection.on('disconnected', (peerAddress: string) => {
    const peerKey = peerAddress.replace('pwa:', '');
    messageHandler.removeClient(peerAddress);
    console.log(`- PWA disconnected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} peers)`);
    serviceState.peerCount = connection.getPeerCount();
    if (!connection.hasPeers()) serviceState.connectionState = 'disconnected';
    writeServiceState(serviceState);
    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.peerDisconnected',
      params: { peerId: peerKey.slice(0, 12), peerCount: connection.getPeerCount() },
    });
  });

  connection.on('error', (error: Error) => {
    console.error('Connection error:', error.message);
  });

  // Persist ready state — daemon becomes discoverable by CLI clients
  writeServiceState(serviceState);

  // Start signaling connection (may be slow — all IPC methods already registered above)
  try {
    await connection.start();
    console.log('Signaling connection established');
  } catch (error) {
    console.error('Failed to start signaling connection:', error);
    // Daemon continues running — will retry on reconnect
  }

  // 6. Heartbeat loop
  heartbeatTimer = setInterval(() => {
    serviceState.lastHeartbeatAt = new Date().toISOString();
    serviceState.peerCount = connection.getPeerCount();
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

    messageHandler.cleanup();
    connection.disconnect();
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

// ---------------------------------------------------------------------------
// IPC method registration
// ---------------------------------------------------------------------------

function registerDaemonMethods(
  ipcServer: IpcServer,
  connection: AgentConnection,
  messageHandler: MessageHandler,
  config: { agentId: string; keyPair: { publicKey: string }; signalingServer: string },
): void {
  // get-pairing-info
  ipcServer.registerMethod('get-pairing-info', (): PairingInfoResult => {
    const pairingUrl = `https://quicksave.dev/connect?id=${config.agentId}&pk=${encodeURIComponent(config.keyPair.publicKey)}&name=${encodeURIComponent(hostname())}`;
    return {
      agentId: config.agentId,
      publicKey: config.keyPair.publicKey,
      pairingUrl,
      connectionState: connection.hasPeers() ? 'connected' : 'disconnected',
      peerCount: connection.getPeerCount(),
    };
  });

  // list-repos
  ipcServer.registerMethod('list-repos', async (): Promise<{ repos: RepoInfo[] }> => {
    const paths = getManagedRepos();
    const repos: RepoInfo[] = [];
    for (const path of paths) {
      const git = new GitOperations(path);
      const valid = await git.isValidRepo();
      let currentBranch: string | undefined;
      if (valid) {
        try {
          const branches = await git.getBranches();
          currentBranch = branches.current;
        } catch { /* ignore */ }
      }
      repos.push({ path, name: basename(path), valid, currentBranch });
    }
    return { repos };
  });

  // add-repo
  ipcServer.registerMethod('add-repo', async (params): Promise<{ added: boolean; repo?: RepoInfo }> => {
    const path = params.path as string;
    if (!path) throw Object.assign(new Error('Missing path'), { rpcCode: -32602 });

    const git = new GitOperations(path);
    const valid = await git.isValidRepo();
    if (!valid) {
      throw Object.assign(new Error(`Not a valid git repository: ${path}`), { rpcCode: -32602 });
    }

    addManagedRepo(path);

    const rootPath = await git.getGitRoot();
    const branches = await git.getBranches();
    const repo: RepoInfo = { path: rootPath, name: basename(rootPath), valid: true, currentBranch: branches.current };

    // Update running message handler so PWA can use the repo immediately
    messageHandler.addRepo({ path: rootPath, name: basename(rootPath), currentBranch: branches.current });

    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.repoAdded',
      params: { repo },
    });

    return { added: true, repo };
  });

  // remove-repo
  ipcServer.registerMethod('remove-repo', (params): { removed: boolean } => {
    const path = params.path as string;
    if (!path) throw Object.assign(new Error('Missing path'), { rpcCode: -32602 });

    removeManagedRepo(path);
    messageHandler.removeRepo(path);

    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.repoRemoved',
      params: { path },
    });

    return { removed: true };
  });

  // restart
  ipcServer.registerMethod('restart', (): { ok: true } => {
    process.nextTick(() => ipcServer.emit('shutdown-requested'));
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Repo validation helper
// ---------------------------------------------------------------------------

async function validateRepos(paths: string[]): Promise<Repository[]> {
  const repos: Repository[] = [];
  for (const repoPath of paths) {
    const git = new GitOperations(repoPath);
    const valid = await git.isValidRepo();
    if (!valid) {
      console.warn(`  Skipping invalid repo: ${repoPath}`);
      continue;
    }
    try {
      const rootPath = await git.getGitRoot();
      const { current: currentBranch } = await git.getBranches();
      repos.push({ path: rootPath, name: basename(rootPath), currentBranch });
    } catch (err) {
      console.warn(`  Failed to read repo: ${repoPath}`, err);
    }
  }
  return repos;
}
