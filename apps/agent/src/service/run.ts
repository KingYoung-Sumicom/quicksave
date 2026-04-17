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

import { basename, join, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { getOrCreateConfig, getManagedRepos, getManagedCodingPaths, addManagedRepo, removeManagedRepo } from '../config.js';
import { AgentConnection } from '../connection/connection.js';
import { MessageHandler } from '../handlers/messageHandler.js';
import { GitOperations } from '../git/operations.js';
import { IpcServer } from './ipcServer.js';
import { DebugHttpServer } from './debugHttpServer.js';
import {
  acquireLock,
  ensureDirectories,
  getSocketPath,
  getRunDir,
  cleanStaleRuntime,
} from './singleton.js';
import { writeServiceState, removeServiceState } from './stateStore.js';
import { IPC_VERSION, BUILD_ID, isDebugEnabled } from './types.js';
import type { ServiceState, StatusResult, PairingInfoResult, RepoInfo, DebugResult } from './types.js';
import { createMessage, type Message, type Repository } from '@sumicom/quicksave-shared';
import { getSessionRegistry } from '../ai/sessionRegistry.js';
import { getEventStore } from '../storage/eventStore.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PACKAGE_VERSION = '0.6.3';

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

  const isProduction = !BUILD_ID.startsWith('dev-');
  const messageHandler = new MessageHandler(validRepos, config.license, codingPaths, isProduction);

  // Self-restart after update: spawn a detached launcher that
  // 1. sanity-checks the new binary (--version)
  // 2. only then kills the old daemon
  // 3. starts the new daemon
  // If the sanity check fails, old daemon stays alive untouched.
  messageHandler.onRestartRequested = () => {
    console.log('Update complete — spawning upgrade launcher...');
    const thisFile = fileURLToPath(import.meta.url);
    const isTs = thisFile.endsWith('.ts');
    const entryPath = resolve(dirname(thisFile), isTs ? '../index.ts' : '../index.js');
    const logPath = join(getRunDir(), 'daemon.log');
    const node = process.execPath;
    const nf = isTs ? `--import tsx ` : '';
    const oldPid = process.pid;
    // Escape single quotes in paths for safe shell interpolation
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    // Detached shell: verify → kill old → start new
    const script = [
      `sleep 1`,
      // Sanity-check: if new binary can't even print version, abort
      `${sq(node)} ${nf}${sq(entryPath)} --version > /dev/null 2>&1`,
      `|| { echo "[upgrade] new binary failed sanity check, aborting" >> ${sq(logPath)}; exit 1; }`,
      // New binary works — kill old daemon (graceful shutdown releases lock)
      `kill ${oldPid}`,
      // Wait for old daemon to fully exit and release lock
      `for i in 1 2 3 4 5; do kill -0 ${oldPid} 2>/dev/null || break; sleep 1; done`,
      // Start new daemon
      `${sq(node)} ${nf}${sq(entryPath)} service run >> ${sq(logPath)} 2>&1`,
    ].join(' && ');
    spawn('sh', ['-c', script], {
      detached: true, stdio: 'ignore', env: process.env,
    }).unref();
  };

  // Pub/sub: ClaudeCodeService emits card events → send only to peers subscribed to that session
  const claudeService = messageHandler.getClaudeService();
  claudeService.on('card-event', (event) => {
    connection.sendToSession(event.sessionId, createMessage('claude:card-event', event));
  });
  claudeService.on('card-stream-end', (result) => {
    connection.sendToSession(result.sessionId, createMessage('claude:card-stream-end', result));

    const cwd = claudeService.getSessionCwd(result.sessionId);
    const inputTokens = result.tokenUsage?.input ?? 0;
    const outputTokens = result.tokenUsage?.output ?? 0;
    const cacheCreationTokens = result.tokenUsage?.cacheCreation ?? 0;
    const cacheReadTokens = result.tokenUsage?.cacheRead ?? 0;
    const costUsd = result.totalCostUsd ?? 0;

    // Fetch the CLI's context-window breakdown before recording the turn.
    // Only the Claude Code CLI responds; other providers return null quickly.
    // Fire-and-record to avoid blocking the peer notification above.
    (async () => {
      const contextUsage = await claudeService.getSessionContextUsage(result.sessionId).catch(() => null);

      getEventStore().record({
        type: 'turn_ended',
        sessionId: result.sessionId,
        cwd: cwd ?? null,
        data: {
          success: result.success,
          interrupted: result.interrupted ?? false,
          error: result.error,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          costUsd,
          ...(contextUsage ? { contextUsage: { ...contextUsage, capturedAt: Date.now() } } : {}),
        },
      });

      // Update session registry with cost/message count
      if (cwd) {
        const registry = getSessionRegistry();
        const entry = registry.getEntry(cwd, result.sessionId);
        if (entry) {
          registry.updateEntry(cwd, result.sessionId, {
            messageCount: (entry.messageCount ?? 0) + 1,
            totalCostUsd: (entry.totalCostUsd ?? 0) + costUsd,
            lastAccessedAt: Date.now(),
          });
        }
      }
    })().catch((err) => {
      console.error(`[turn_ended] failed to record turn for session=${result.sessionId.slice(0, 8)}:`, err);
    });
  });
  claudeService.on('user-input-request', (request) => {
    connection.sendToSession(request.sessionId, createMessage('claude:user-input-request', request));
    getEventStore().record({
      type: 'permission_requested',
      sessionId: request.sessionId,
      data: {
        requestId: request.requestId,
        inputType: request.inputType,
        title: request.title,
      },
    });
  });
  claudeService.on('user-input-resolved', (info) => {
    connection.sendToSession(info.sessionId, createMessage('claude:user-input-resolved', info));
    getEventStore().record({
      type: 'permission_resolved',
      sessionId: info.sessionId,
      data: { requestId: info.requestId },
    });
  });
  claudeService.on('session-updated', (info) => {
    // session-updated goes to all peers (needed for session list status dots)
    connection.broadcast(createMessage('claude:session-updated', info));
  });
  claudeService.on('preferences-updated', (prefs) => {
    connection.broadcast(createMessage('claude:preferences-updated', prefs));
  });
  claudeService.on('session-config-updated', (payload) => {
    connection.broadcast(createMessage('session:config-updated', payload));
  });

  // Per-repo commit-summary state (agent-owned, broadcast to all peers so each
  // PWA can mirror the pending suggestion + generation progress).
  const commitSummaryStore = messageHandler.getCommitSummaryStore();
  commitSummaryStore.on('state-updated', (state) => {
    connection.broadcast(createMessage('ai:commit-summary:updated', state));
  });

  // Init preferences from the last session's JSONL (best-effort, non-blocking)
  claudeService.initPreferences().catch(() => {});

  // Init session registry (loads all entries from disk)
  getSessionRegistry();

  // Track which session each peer is viewing.
  // Permission state is now carried directly on cards (via CardBuilder),
  // so getCards() returns cards with pendingInput already attached.
  // No need to re-send user-input-request on subscribe.
  messageHandler.onPeerSubscribed = (peerAddress, sessionId) => {
    connection.subscribePeerToSession(peerAddress, sessionId);
  };

  messageHandler.onPeerUnsubscribed = (peerAddress, sessionId) => {
    connection.unsubscribePeerFromSession(peerAddress, sessionId);
  };

  messageHandler.onHistoryUpdated = (cwd, entry, action) => {
    connection.broadcast(createMessage('session:history-updated', { cwd, entry, action }));
  };

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

  // Start debug HTTP server (local-only, gated by debug mode)
  let debugHttpServer: DebugHttpServer | null = null;
  if (isDebugEnabled()) {
    debugHttpServer = new DebugHttpServer(claudeService);
    debugHttpServer.start().catch((err) => {
      console.warn('Failed to start debug HTTP server:', err);
    });
  }

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
    if (debugHttpServer) await debugHttpServer.close();
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
    const pairingUrl = `https://quicksave.dev/#/connect/${config.agentId}?pk=${encodeURIComponent(config.keyPair.publicKey)}&name=${encodeURIComponent(hostname())}`;
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

  // Debug methods — gated by QUICKSAVE_DEBUG / dev mode
  if (!isDebugEnabled()) return;

  // debug — full daemon introspection snapshot
  ipcServer.registerMethod('debug', (): DebugResult => {
    const connState = connection.getDebugState();
    const claudeState = messageHandler.getClaudeService().getDebugState();
    return {
      pid: process.pid,
      uptime: process.uptime(),
      peers: connState.peers,
      subscriptions: connState.subscriptions,
      pendingInputs: claudeState.pendingInputs,
      activeSessions: claudeState.activeSessions,
    };
  });

  // resolve-input — force-resolve a stuck permission request
  ipcServer.registerMethod('resolve-input', (params): { resolved: boolean } => {
    const requestId = params.requestId as string;
    const action = (params.action as string) || 'allow';
    if (!requestId) throw Object.assign(new Error('Missing requestId'), { rpcCode: -32602 });
    const resolved = messageHandler.getClaudeService().resolveUserInput({
      requestId,
      sessionId: '',
      action: action as 'allow' | 'deny',
    });
    return { resolved };
  });

  // list-sessions — SDK sessions enriched with live state
  ipcServer.registerMethod('list-sessions', async (params): Promise<{ sessions: unknown[] }> => {
    const cwd = (params.cwd as string) || getManagedRepos()[0] || process.cwd();
    const sessions = await messageHandler.getClaudeService().listAvailableSessions(cwd);
    return { sessions };
  });

  // get-cards — card history for a session
  ipcServer.registerMethod('get-cards', async (params): Promise<unknown> => {
    const sessionId = params.sessionId as string;
    const cwd = (params.cwd as string) || getManagedRepos()[0] || process.cwd();
    const offset = (params.offset as number) || 0;
    const limit = (params.limit as number) || 50;
    if (!sessionId) throw Object.assign(new Error('Missing sessionId'), { rpcCode: -32602 });
    return messageHandler.getClaudeService().getCards(sessionId, cwd, offset, limit);
  });
}

// ---------------------------------------------------------------------------
// Repo validation helper
// ---------------------------------------------------------------------------

async function validateRepos(paths: string[]): Promise<Repository[]> {
  const repos: Repository[] = [];
  const removed: string[] = [];
  for (const repoPath of paths) {
    if (!existsSync(repoPath)) {
      console.warn(`  Removing missing repo: ${repoPath}`);
      removed.push(repoPath);
      continue;
    }
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
  for (const p of removed) removeManagedRepo(p);
  return repos;
}
