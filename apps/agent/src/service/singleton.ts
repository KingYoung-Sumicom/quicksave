/**
 * Singleton lock for ensuring exactly one daemon per user.
 *
 * Uses an exclusive lock file at ~/.quicksave/run/service.lock.
 * The lock is held via an open file descriptor — if the process crashes,
 * the OS releases the lock automatically.
 */

import { openSync, closeSync, writeSync, readFileSync, mkdirSync, existsSync, unlinkSync, constants } from 'fs';
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

export function getSessionRegistryDir(): string {
  return join(getStateDir(), 'session-registry');
}

export function getLogsDir(): string {
  return join(QUICKSAVE_DIR, 'logs');
}

/**
 * Ensure all required directories exist.
 */
export function ensureDirectories(): void {
  for (const dir of [RUN_DIR, getStateDir(), getSessionsDir(), getSessionRegistryDir(), getLogsDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Try to acquire the singleton lock.
 * Returns a release function on success, or null if the lock is held by another process.
 *
 * The lock file contains the PID of the owning process. If the file exists but
 * the PID is dead, we reclaim the lock (crash recovery).
 */
export function acquireLock(): (() => void) | null {
  ensureDirectories();

  // Check for stale lock: if lock file exists but PID is dead, remove it
  if (existsSync(LOCK_FILE)) {
    try {
      const pidStr = readFileSync(LOCK_FILE, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && !isProcessAlive(pid)) {
        // Stale lock — previous daemon crashed
        unlinkSync(LOCK_FILE);
      }
    } catch {
      // Can't read lock file — remove it and retry
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    }
  }

  try {
    const fd = openSync(LOCK_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    // Write our PID so future processes can detect stale locks
    writeSync(fd, Buffer.from(String(process.pid)));
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
