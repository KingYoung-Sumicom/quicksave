/**
 * Singleton lock for ensuring exactly one daemon per user.
 *
 * Uses an exclusive lock file at <quicksaveDir>/run/service.lock.
 * The lock is held via an open file descriptor — if the process crashes,
 * the OS releases the lock automatically.
 *
 * All paths derive from a single configurable base directory:
 *   - Default: ~/.quicksave
 *   - Override: QUICKSAVE_HOME env var, or setQuicksaveDir() for tests
 */

import { openSync, closeSync, writeSync, readFileSync, mkdirSync, existsSync, unlinkSync, constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let _quicksaveDir: string = process.env.QUICKSAVE_HOME || join(homedir(), '.quicksave');

/**
 * Get the quicksave base directory.
 * All other paths derive from this.
 */
export function getQuicksaveDir(): string {
  return _quicksaveDir;
}

/**
 * Override the base directory. Primarily for tests.
 * Call before any other path function to ensure consistency.
 */
export function setQuicksaveDir(dir: string): void {
  _quicksaveDir = dir;
}

export function getRunDir(): string {
  return join(_quicksaveDir, 'run');
}

export function getSocketPath(): string {
  return join(getRunDir(), 'service.sock');
}

export function getLockPath(): string {
  return join(getRunDir(), 'service.lock');
}

export function getStateDir(): string {
  return join(_quicksaveDir, 'state');
}

export function getSessionsDir(): string {
  return join(getStateDir(), 'sessions');
}

export function getSessionRegistryDir(): string {
  return join(getStateDir(), 'session-registry');
}

export function getLogsDir(): string {
  return join(_quicksaveDir, 'logs');
}

export function getDebugDir(): string {
  return join(_quicksaveDir, 'debug');
}

export function getConfigFile(): string {
  return join(_quicksaveDir, 'agent.json');
}

export function getCardHistoryDir(): string {
  return join(getStateDir(), 'card-history');
}

/**
 * Ensure all required directories exist.
 */
export function ensureDirectories(): void {
  for (const dir of [getRunDir(), getStateDir(), getSessionsDir(), getSessionRegistryDir(), getLogsDir()]) {
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

  const lockFile = getLockPath();

  // Check for stale lock: if lock file exists but PID is dead, remove it
  if (existsSync(lockFile)) {
    try {
      const pidStr = readFileSync(lockFile, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && !isProcessAlive(pid)) {
        // Stale lock — previous daemon crashed
        unlinkSync(lockFile);
      }
    } catch {
      // Can't read lock file — remove it and retry
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }

  try {
    const fd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    // Write our PID so future processes can detect stale locks
    writeSync(fd, Buffer.from(String(process.pid)));
    return () => {
      try {
        closeSync(fd);
        unlinkSync(lockFile);
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
  for (const file of [getLockPath(), getSocketPath()]) {
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
