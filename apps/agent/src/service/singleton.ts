/**
 * Singleton lock for ensuring exactly one daemon per user.
 *
 * Uses an exclusive lock file at ~/.quicksave/run/service.lock.
 * The lock is held via an open file descriptor — if the process crashes,
 * the OS releases the lock automatically.
 */

import { openSync, closeSync, mkdirSync, existsSync, unlinkSync, constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const QUICKSAVE_DIR = join(homedir(), '.quicksave');
const RUN_DIR = join(QUICKSAVE_DIR, 'run');
const LOCK_FILE = join(RUN_DIR, 'service.lock');
const SOCKET_PATH = join(RUN_DIR, 'service.sock');

export function getRunDir(): string {
  return RUN_DIR;
}

export function getSocketPath(): string {
  return SOCKET_PATH;
}

export function getLockPath(): string {
  return LOCK_FILE;
}

export function getStateDir(): string {
  return join(QUICKSAVE_DIR, 'state');
}

export function getSessionsDir(): string {
  return join(getStateDir(), 'sessions');
}

export function getLogsDir(): string {
  return join(QUICKSAVE_DIR, 'logs');
}

/**
 * Ensure all required directories exist.
 */
export function ensureDirectories(): void {
  for (const dir of [RUN_DIR, getStateDir(), getSessionsDir(), getLogsDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Try to acquire the singleton lock.
 * Returns a release function on success, or null if the lock is held by another process.
 */
export function acquireLock(): (() => void) | null {
  ensureDirectories();

  try {
    const fd = openSync(LOCK_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    return () => {
      try {
        closeSync(fd);
        unlinkSync(LOCK_FILE);
      } catch {
        // Best-effort cleanup
      }
    };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      return null;
    }
    throw err;
  }
}

/**
 * Remove stale runtime files (lock, socket) when we detect a dead daemon.
 */
export function cleanStaleRuntime(): void {
  for (const file of [LOCK_FILE, SOCKET_PATH]) {
    try {
      unlinkSync(file);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        // Ignore missing files, rethrow anything else
        throw err;
      }
    }
  }
}

/**
 * Check if a PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
