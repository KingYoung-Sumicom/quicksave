import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

// We test the helper functions directly rather than the module-level constants
import { isProcessAlive } from './singleton.js';
import { shouldRestartDaemon, IPC_VERSION, BUILD_ID } from './types.js';
import type { HelloResult } from './types.js';

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe('shouldRestartDaemon', () => {
  const makeDaemon = (overrides: Partial<HelloResult> = {}): HelloResult => ({
    daemonVersion: '0.4.0',
    daemonIpcVersion: IPC_VERSION,
    daemonBuildId: BUILD_ID,
    daemonPid: 12345,
    ...overrides,
  });

  it('returns ok when versions match', () => {
    const result = shouldRestartDaemon(
      makeDaemon(),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('ok');
  });

  it('returns restart when daemon ipcVersion is lower', () => {
    const result = shouldRestartDaemon(
      makeDaemon({ daemonIpcVersion: 0 }),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('restart');
  });

  it('returns warn_outdated when CLI ipcVersion is lower', () => {
    const result = shouldRestartDaemon(
      makeDaemon({ daemonIpcVersion: 99 }),
      { ipcVersion: IPC_VERSION, buildId: BUILD_ID },
    );
    expect(result.action).toBe('warn_outdated');
  });

  it('returns ok when buildId differs in production', () => {
    // Default NODE_ENV is not "development"
    const result = shouldRestartDaemon(
      makeDaemon({ daemonBuildId: 'old-build' }),
      { ipcVersion: IPC_VERSION, buildId: 'new-build' },
    );
    expect(result.action).toBe('ok');
  });
});
