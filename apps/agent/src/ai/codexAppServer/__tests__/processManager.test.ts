// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetCodexBinCache,
  buildCodexCliEnv,
  checkSchemaVersionCompatibility,
  getCodexBin,
} from '../processManager.js';
import { buildCodexSandboxMcpConfigArgs } from '../provider.js';

const originalEnv = { ...process.env };
const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quicksave-codex-bin-'));
  tmpRoots.push(root);
  return root;
}

function writeExecutable(path: string, text = '#!/bin/sh\nexit 0\n'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  _resetCodexBinCache();
  process.env = { ...originalEnv };
  delete process.env.QUICKSAVE_CODEX_BIN;
});

afterEach(() => {
  _resetCodexBinCache();
  process.env = { ...originalEnv };
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('getCodexBin', () => {
  it('honors QUICKSAVE_CODEX_BIN', () => {
    process.env.QUICKSAVE_CODEX_BIN = '/custom/bin/codex';
    expect(getCodexBin()).toBe('/custom/bin/codex');
  });

  it('returns a codex executable found on PATH', () => {
    const root = makeTmpRoot();
    const bin = join(root, 'bin');
    const codex = join(bin, 'codex');
    writeExecutable(codex);
    process.env.PATH = bin;

    expect(getCodexBin()).toBe(codex);
  });

  it('falls back to nvm global installs when PATH is minimal', () => {
    const home = makeTmpRoot();
    const codex = join(home, '.nvm', 'versions', 'node', 'v24.14.1', 'bin', 'codex');
    writeExecutable(codex);
    process.env.HOME = home;
    process.env.PATH = '';

    expect(getCodexBin()).toBe(codex);
  });

  it('falls back to the bare command when no executable is found', () => {
    process.env.HOME = makeTmpRoot();
    process.env.PATH = '';

    expect(getCodexBin()).toBe('codex');
  });
});

describe('buildCodexCliEnv', () => {
  it('prepends the Codex bin directory and current Node directory', () => {
    const codex = '/home/user/.nvm/versions/node/v24.14.1/bin/codex';
    const env = buildCodexCliEnv({ PATH: '/usr/bin' }, codex);

    expect(env.PATH.split(delimiter).slice(0, 3)).toEqual([
      dirname(codex),
      dirname(process.execPath),
      '/usr/bin',
    ]);
  });

  it('deduplicates PATH entries', () => {
    const codex = '/home/user/.nvm/versions/node/v24.14.1/bin/codex';
    const env = buildCodexCliEnv({ PATH: `${dirname(codex)}${delimiter}/usr/bin` }, codex);

    expect(env.PATH.split(delimiter).filter((part) => part === dirname(codex))).toHaveLength(1);
  });
});

describe('checkSchemaVersionCompatibility', () => {
  it('does not warn when major.minor matches the pin', () => {
    const log = { warn: vi.fn() };
    checkSchemaVersionCompatibility('0.125.0', log, '0.125.0');
    checkSchemaVersionCompatibility('0.125.7', log, '0.125.0');
    checkSchemaVersionCompatibility('v0.125.4', log, '0.125.0');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns on minor mismatch', () => {
    const log = { warn: vi.fn() };
    checkSchemaVersionCompatibility('0.126.0', log, '0.125.0');
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toMatch(/differs from schema pin/);
  });

  it('warns on major mismatch', () => {
    const log = { warn: vi.fn() };
    checkSchemaVersionCompatibility('1.0.0', log, '0.125.0');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('warns once when version is unparseable', () => {
    const log = { warn: vi.fn() };
    checkSchemaVersionCompatibility('not-a-semver', log, '0.125.0');
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toMatch(/unparseable version/);
  });
});

describe('buildCodexSandboxMcpConfigArgs', () => {
  it('emits codex -c overrides for the quicksave MCP server', () => {
    const args = buildCodexSandboxMcpConfigArgs({ cwd: '/tmp/project', sessionId: 'thr_123' });
    expect(args).toEqual([
      '-c',
      expect.stringMatching(/^mcp_servers\.quicksave-sandbox\.command="/),
      '-c',
      expect.stringContaining('mcp_servers.quicksave-sandbox.args='),
      '-c',
      'mcp_servers.quicksave-sandbox.default_tools_approval_mode="approve"',
      '-c',
      'mcp_servers.quicksave-sandbox.tools.UpdateSessionStatus.approval_mode="approve"',
      '-c',
      'mcp_servers.quicksave-sandbox.tools.DisplayMarkdownReport.approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.default_tools_approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.default_tools_enabled=true',
      '-c',
      'apps.quicksave-sandbox.destructive_enabled=true',
      '-c',
      'apps.quicksave-sandbox.open_world_enabled=true',
      '-c',
      'apps.quicksave-sandbox.tools.UpdateSessionStatus.approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.tools.DisplayMarkdownReport.approval_mode="approve"',
    ]);
    expect(args[3]).toContain('"--cwd"');
    expect(args[3]).toContain('"/tmp/project"');
    expect(args[3]).toContain('"--session-id"');
    expect(args[3]).toContain('"thr_123"');
    expect(args[3]).toContain('"--no-sandbox-bash"');
    expect(args.join('\n')).not.toContain('SandboxBash');
  });
});
