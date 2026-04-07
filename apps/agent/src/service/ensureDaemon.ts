/**
 * ensureDaemon — connect to an existing daemon or auto-start one.
 *
 * Flow:
 * 1. Read service.json for socket path. Quick pre-check: if PID is dead, skip to step 4.
 * 2. Connect to socket, send hello (both liveness check and version exchange).
 * 3. Inspect HelloResult for version compatibility. If compatible, attach.
 *    If restart needed, proceed to step 4.
 * 4. If stale or version mismatch, remove stale runtime files and start a new daemon.
 * 5. If lock acquisition fails, retry attach with backoff (up to 3 attempts, 500ms base delay).
 */

import { fork } from 'child_process';
import { openSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { IpcClient } from './ipcClient.js';
import { readServiceState } from './stateStore.js';
import { isProcessAlive, cleanStaleRuntime, getRunDir } from './singleton.js';
import { shouldRestartDaemon, IPC_VERSION, BUILD_ID } from './types.js';
import type { HelloResult } from './types.js';

const MAX_ATTACH_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;
const DAEMON_READY_TIMEOUT_MS = 10_000;
const DAEMON_READY_POLL_MS = 200;

export interface EnsureDaemonResult {
  client: IpcClient;
  hello: HelloResult;
}

/**
 * Ensure the daemon is running and return a connected IPC client.
 * Auto-starts a new daemon if needed.
 */
export async function ensureDaemon(): Promise<EnsureDaemonResult> {
  for (let attempt = 0; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    // Step 1: Read service.json
    const state = readServiceState();

    if (state) {
      // Quick pre-check: is the PID alive?
      if (!isProcessAlive(state.pid)) {
        cleanStaleRuntime();
        return startAndConnect();
      }

      // Step 2: Try connecting
      try {
        const client = new IpcClient();
        const hello = await client.connect(state.socketPath);

        // Step 3: Check version compatibility
        const check = shouldRestartDaemon(hello, { ipcVersion: IPC_VERSION, buildId: BUILD_ID });

        if (check.action === 'ok') {
          return { client, hello };
        }

        if (check.action === 'warn_outdated') {
          console.warn('Warning: CLI is outdated. Please update quicksave.');
          return { client, hello };
        }

        // action === 'restart'
        client.close();
        await requestShutdownAndWait(state.socketPath);
        cleanStaleRuntime();
        return startAndConnect();
      } catch {
        // Connection failed — daemon might be stale or starting
        if (attempt < MAX_ATTACH_RETRIES) {
          await sleep(BASE_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        // Last attempt — clean up and start fresh
        cleanStaleRuntime();
        return startAndConnect();
      }
    } else {
      // No service.json — start a new daemon
      return startAndConnect();
    }
  }

  // Should not reach here, but just in case
  throw new Error('Failed to connect to daemon after retries');
}

/**
 * Spawn a new daemon process in detached mode and wait for it to be ready.
 */
async function startAndConnect(): Promise<EnsureDaemonResult> {
  spawnDaemon();
  return waitForDaemon();
}

/**
 * Spawn `quicksave service run` as a detached background process.
 */
function spawnDaemon(): void {
  const thisFile = fileURLToPath(import.meta.url);
  const isTs = thisFile.endsWith('.ts');
  const entryPath = resolve(thisFile, isTs ? '../../index.ts' : '../../index.js');

  // Ensure run directory exists before opening log file (daemon hasn't started yet)
  const runDir = getRunDir();
  mkdirSync(runDir, { recursive: true });
  const logFd = openSync(join(runDir, 'daemon.log'), 'a');
  const child = fork(entryPath, ['service', 'run'], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
    execArgv: isTs ? ['--import', 'tsx'] : [],
  });

  child.unref();
}

/**
 * Poll until the daemon is ready (service.json exists and IPC responds).
 */
async function waitForDaemon(): Promise<EnsureDaemonResult> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = readServiceState();
    if (state && isProcessAlive(state.pid)) {
      try {
        const client = new IpcClient();
        const hello = await client.connect(state.socketPath);
        return { client, hello };
      } catch {
        // Not ready yet
      }
    }
    await sleep(DAEMON_READY_POLL_MS);
  }

  throw new Error('Timed out waiting for daemon to start');
}

/**
 * Send shutdown to the daemon and wait for the process to exit.
 */
async function requestShutdownAndWait(socketPath: string): Promise<void> {
  try {
    const client = new IpcClient();
    await client.connect(socketPath);
    await client.request('shutdown');
    client.close();
  } catch {
    // If we can't connect, the daemon is already gone
  }

  // Wait briefly for the process to exit
  await sleep(500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
