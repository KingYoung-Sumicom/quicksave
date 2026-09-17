// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { startUserUnit, wasLaunchedBySystemd } from './systemdUnit.js';
import { requestDaemonRestart } from './restart.js';

vi.mock('child_process');
vi.mock('./systemdUnit.js', () => ({
  startUserUnit: vi.fn(),
  wasLaunchedBySystemd: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedStartUserUnit = vi.mocked(startUserUnit);
const mockedWasLaunchedBySystemd = vi.mocked(wasLaunchedBySystemd);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('requestDaemonRestart', () => {
  it('delegates to systemd instead of spawning a cgroup-bound launcher', () => {
    mockedWasLaunchedBySystemd.mockReturnValue(true);
    mockedStartUserUnit.mockReturnValue(true);

    requestDaemonRestart();

    expect(mockedStartUserUnit).toHaveBeenCalledOnce();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('does not fall back to a detached launcher when systemd restart fails', () => {
    mockedWasLaunchedBySystemd.mockReturnValue(true);
    mockedStartUserUnit.mockReturnValue(false);

    requestDaemonRestart();

    expect(mockedStartUserUnit).toHaveBeenCalledOnce();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('keeps the detached launcher for non-systemd installations', () => {
    mockedWasLaunchedBySystemd.mockReturnValue(false);
    const unref = vi.fn();
    mockedSpawn.mockReturnValue({ unref } as any);

    requestDaemonRestart();

    expect(mockedStartUserUnit).not.toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalledWith('sh', ['-c', expect.any(String)], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
    }));
    expect(unref).toHaveBeenCalledOnce();
  });
});
