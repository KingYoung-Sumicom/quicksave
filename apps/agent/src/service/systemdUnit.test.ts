// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { platform, homedir } from 'os';
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';

vi.mock('child_process');
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: vi.fn(() => 'linux'),
    homedir: vi.fn(() => '/home/test'),
  };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedPlatform = vi.mocked(platform);
const mockedHomedir = vi.mocked(homedir);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

const {
  wasLaunchedBySystemd,
  userUnitIsEnabled,
  startUserUnit,
  QUICKSAVE_UNIT,
  renderUnitText,
  computeExecStart,
  getUserUnitDir,
  getUserUnitPath,
  getSystemdStatus,
  readInstalledExecStart,
  installUserUnit,
  uninstallUserUnit,
} = await import('./systemdUnit.js');

const ok = { status: 0, error: undefined, stderr: Buffer.from('') } as any;
const fail = (status: number, msg = 'boom') =>
  ({ status, error: undefined, stderr: Buffer.from(msg) }) as any;
const errored = (msg = 'ENOENT') => ({ status: null, error: new Error(msg), stderr: Buffer.from('') }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  mockedPlatform.mockReturnValue('linux');
  mockedHomedir.mockReturnValue('/home/test');
  mockedExistsSync.mockReturnValue(false);
  // GitHub Actions runners set XDG_CONFIG_HOME, which getUserUnitDir prefers
  // over homedir(). Clear it so the homedir fallback (and thus the mock) wins.
  delete process.env.XDG_CONFIG_HOME;
});

describe('wasLaunchedBySystemd', () => {
  it('detects INVOCATION_ID', () => {
    expect(wasLaunchedBySystemd({ INVOCATION_ID: 'abc' })).toBe(true);
  });

  it('detects JOURNAL_STREAM', () => {
    expect(wasLaunchedBySystemd({ JOURNAL_STREAM: '8:1234' })).toBe(true);
  });

  it('returns false when neither env var is set', () => {
    expect(wasLaunchedBySystemd({})).toBe(false);
  });

  it('returns false when both env vars are empty strings', () => {
    expect(wasLaunchedBySystemd({ INVOCATION_ID: '', JOURNAL_STREAM: '' })).toBe(false);
  });
});

describe('userUnitIsEnabled', () => {
  it('returns false on non-Linux platforms without spawning', () => {
    mockedPlatform.mockReturnValue('darwin');
    expect(userUnitIsEnabled()).toBe(false);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('returns true when systemctl exits 0', () => {
    mockedSpawnSync.mockReturnValue(ok);
    expect(userUnitIsEnabled()).toBe(true);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'is-enabled', '--quiet', QUICKSAVE_UNIT],
      expect.any(Object),
    );
  });

  it('returns false when systemctl exits non-zero (unit disabled)', () => {
    mockedSpawnSync.mockReturnValue(fail(1));
    expect(userUnitIsEnabled()).toBe(false);
  });

  it('returns false when systemctl is missing (ENOENT)', () => {
    mockedSpawnSync.mockReturnValue(errored());
    expect(userUnitIsEnabled()).toBe(false);
  });

  it('returns false when systemctl times out (no status, no error)', () => {
    mockedSpawnSync.mockReturnValue({ status: null, error: undefined, stderr: Buffer.from('') } as any);
    expect(userUnitIsEnabled()).toBe(false);
  });
});

describe('startUserUnit', () => {
  it('returns false on non-Linux platforms', () => {
    mockedPlatform.mockReturnValue('win32');
    expect(startUserUnit()).toBe(false);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('issues systemctl --user restart for the unit', () => {
    mockedSpawnSync.mockReturnValue(ok);
    expect(startUserUnit()).toBe(true);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'restart', QUICKSAVE_UNIT],
      expect.any(Object),
    );
  });

  it('returns false when systemctl errors', () => {
    mockedSpawnSync.mockReturnValue(errored('boom'));
    expect(startUserUnit()).toBe(false);
  });

  it('returns false when systemctl exits non-zero', () => {
    mockedSpawnSync.mockReturnValue(fail(5));
    expect(startUserUnit()).toBe(false);
  });
});

describe('renderUnitText', () => {
  it('embeds the ExecStart line and required sections', () => {
    const text = renderUnitText('/usr/bin/node /opt/quicksave/index.js service run');
    expect(text).toMatch(/\[Unit\]/);
    expect(text).toMatch(/\[Service\]/);
    expect(text).toMatch(/\[Install\]/);
    expect(text).toMatch(/^ExecStart=\/usr\/bin\/node \/opt\/quicksave\/index.js service run$/m);
    expect(text).toMatch(/^Restart=on-failure$/m);
    expect(text).toMatch(/^WantedBy=default.target$/m);
  });
});

describe('computeExecStart', () => {
  it('produces a tsx --import line for .ts entry resolution', () => {
    const line = computeExecStart('file:///tmp/agent/src/service/systemdUnit.ts');
    expect(line).toContain('--import tsx');
    expect(line).toMatch(/\/tmp\/agent\/src\/index\.ts service run$/);
    expect(line.startsWith(process.execPath)).toBe(true);
  });

  it('produces a plain node line for compiled .js entry', () => {
    const line = computeExecStart('file:///opt/agent/dist/service/systemdUnit.js');
    expect(line).not.toContain('--import tsx');
    expect(line).toMatch(/\/opt\/agent\/dist\/index\.js service run$/);
  });

  it('quotes paths containing whitespace', () => {
    const line = computeExecStart('file:///opt/My%20Apps/agent/dist/service/systemdUnit.js');
    expect(line).toContain('"/opt/My Apps/agent/dist/index.js"');
  });
});

describe('getUserUnitDir / getUserUnitPath', () => {
  it('honors XDG_CONFIG_HOME when set', () => {
    expect(getUserUnitDir({ XDG_CONFIG_HOME: '/custom/xdg' })).toBe('/custom/xdg/systemd/user');
    expect(getUserUnitPath({ XDG_CONFIG_HOME: '/custom/xdg' })).toBe(`/custom/xdg/systemd/user/${QUICKSAVE_UNIT}`);
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(getUserUnitDir({})).toBe('/home/test/.config/systemd/user');
    expect(getUserUnitDir({ XDG_CONFIG_HOME: '' })).toBe('/home/test/.config/systemd/user');
  });
});

describe('readInstalledExecStart', () => {
  it('returns undefined when the unit file is missing', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readInstalledExecStart()).toBeUndefined();
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it('extracts the ExecStart line from a real-looking unit', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      [
        '[Unit]',
        'Description=Quicksave',
        '',
        '[Service]',
        'ExecStart=/usr/bin/node /opt/agent/index.js service run',
        'Restart=on-failure',
      ].join('\n') as any,
    );
    expect(readInstalledExecStart()).toBe('/usr/bin/node /opt/agent/index.js service run');
  });

  it('tolerates a malformed/unreadable unit file', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(readInstalledExecStart()).toBeUndefined();
  });
});

describe('getSystemdStatus', () => {
  it('returns available:false on non-Linux without spawning systemctl', () => {
    mockedPlatform.mockReturnValue('darwin');
    const status = getSystemdStatus();
    expect(status.available).toBe(false);
    expect(status.unitInstalled).toBe(false);
    expect(status.unitEnabled).toBe(false);
    expect(status.isActive).toBe(false);
    expect(status.lingerEnabled).toBe(false);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('reports installed/enabled/active when all signals are positive', () => {
    mockedSpawnSync.mockReturnValue(ok); // every systemctl call passes
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('[Service]\nExecStart=/usr/bin/node /x/index.js service run\n' as any);
    const status = getSystemdStatus();
    expect(status.available).toBe(true);
    expect(status.unitInstalled).toBe(true);
    expect(status.unitEnabled).toBe(true);
    expect(status.isActive).toBe(true);
    expect(status.lingerEnabled).toBe(true);
    expect(status.currentExecStart).toBe('/usr/bin/node /x/index.js service run');
    expect(status.unitDir).toMatch(/systemd\/user$/);
  });

  it('omits currentExecStart when the unit is not installed', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedExistsSync.mockReturnValue(false);
    const status = getSystemdStatus();
    expect(status.unitInstalled).toBe(false);
    expect(status.currentExecStart).toBeUndefined();
  });
});

describe('installUserUnit', () => {
  it('refuses when systemctl is not available', () => {
    mockedPlatform.mockReturnValue('darwin');
    const result = installUserUnit('/usr/bin/node /x/index.js service run');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/systemctl/);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('writes the unit file then runs daemon-reload + enable --now', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedExistsSync.mockReturnValue(false);
    const result = installUserUnit('/usr/bin/node /x/index.js service run');
    expect(result.success).toBe(true);
    expect(mockedMkdirSync).toHaveBeenCalledWith('/home/test/.config/systemd/user', { recursive: true });
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      `/home/test/.config/systemd/user/${QUICKSAVE_UNIT}`,
      expect.stringContaining('ExecStart=/usr/bin/node /x/index.js service run'),
    );
    const calls = mockedSpawnSync.mock.calls.map((c) => c[1]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['--user', '--version'],
        ['--user', 'daemon-reload'],
        ['--user', 'enable', '--now', QUICKSAVE_UNIT],
      ]),
    );
  });

  it('reports a failure if writing the unit file throws', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const result = installUserUnit('/usr/bin/node /x/index.js service run');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EACCES/);
  });

  it('reports daemon-reload failure with the captured stderr', () => {
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      if (args && args.includes('--version')) return ok;
      if (args && args.includes('daemon-reload')) return fail(1, 'reload broke');
      return ok;
    });
    const result = installUserUnit('/usr/bin/node /x/index.js service run');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/daemon-reload failed.*reload broke/);
  });

  it('reports enable failure with the captured stderr', () => {
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      if (args && args.includes('enable')) return fail(1, 'no dbus');
      return ok;
    });
    const result = installUserUnit('/usr/bin/node /x/index.js service run');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/enable --now failed.*no dbus/);
  });
});

describe('uninstallUserUnit', () => {
  it('refuses when systemctl is not available', () => {
    mockedPlatform.mockReturnValue('darwin');
    const result = uninstallUserUnit();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/systemctl/);
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it('disables, removes the file, then daemon-reloads + reset-failed', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedExistsSync.mockReturnValue(true);
    const result = uninstallUserUnit();
    expect(result.success).toBe(true);
    expect(mockedUnlinkSync).toHaveBeenCalledWith(`/home/test/.config/systemd/user/${QUICKSAVE_UNIT}`);
    const argLists = mockedSpawnSync.mock.calls.map((c) => c[1]);
    expect(argLists).toEqual(
      expect.arrayContaining([
        ['--user', 'disable', '--now', QUICKSAVE_UNIT],
        ['--user', 'daemon-reload'],
        ['--user', 'reset-failed', QUICKSAVE_UNIT],
      ]),
    );
  });

  it('skips unlink when the unit file is already gone', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedExistsSync.mockReturnValue(false);
    const result = uninstallUserUnit();
    expect(result.success).toBe(true);
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it('treats disable exit-code 1 as already-disabled (still success)', () => {
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      if (args && args.includes('disable')) return fail(1, 'not loaded');
      return ok;
    });
    mockedExistsSync.mockReturnValue(false);
    const result = uninstallUserUnit();
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('captures a warning when disable errors with a non-1 status', () => {
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      if (args && args.includes('disable')) return fail(5, 'bad state');
      return ok;
    });
    mockedExistsSync.mockReturnValue(false);
    const result = uninstallUserUnit();
    expect(result.success).toBe(true);
    expect(result.error).toMatch(/disable --now warning.*bad state/);
  });

  it('fails if the unit file cannot be removed', () => {
    mockedSpawnSync.mockReturnValue(ok);
    mockedExistsSync.mockReturnValue(true);
    mockedUnlinkSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });
    const result = uninstallUserUnit();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EBUSY/);
  });
});
