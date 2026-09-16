// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildQuicksaveToolsMcpServerConfig, QUICKSAVE_MCP_NAME } from './quicksaveToolsMcp.js';

const __thisDir = dirname(fileURLToPath(import.meta.url));

describe('buildQuicksaveToolsMcpServerConfig', () => {
  it('uses absolute tsx path when quicksaveToolsMcpStdio.ts is present (dev)', () => {
    // This test file lives next to quicksaveToolsMcpStdio.ts so the .ts branch is exercised.
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/some/project',
    });

    expect(cfg.type).toBe('stdio');
    expect(cfg.command).toBe(join(__thisDir, '..', '..', 'node_modules', '.bin', 'tsx'));
    expect(cfg.args[0]).toBe(join(__thisDir, 'quicksaveToolsMcpStdio.ts'));
    expect(cfg.args.slice(1)).toEqual(['--cwd', '/some/project']);
  });

  it('appends --session-id when provided', () => {
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/p',
      sessionId: 'abc-123',
    });
    expect(cfg.args).toEqual([
      join(__thisDir, 'quicksaveToolsMcpStdio.ts'),
      '--cwd', '/p',
      '--session-id', 'abc-123',
    ]);
  });

  it('appends --corr when corrId is provided (fresh session, no session-id)', () => {
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/p',
      corrId: 'corr-xyz',
    });
    expect(cfg.args).toEqual([
      join(__thisDir, 'quicksaveToolsMcpStdio.ts'),
      '--cwd', '/p',
      '--corr', 'corr-xyz',
    ]);
  });

  it('appends both --session-id and --corr when both are provided', () => {
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/p',
      sessionId: 'abc-123',
      corrId: 'corr-xyz',
    });
    expect(cfg.args).toEqual([
      join(__thisDir, 'quicksaveToolsMcpStdio.ts'),
      '--cwd', '/p',
      '--session-id', 'abc-123',
      '--corr', 'corr-xyz',
    ]);
  });

  it('exposes native completion registration only when the Codex provider opts in', () => {
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/p',
      includeNativeCompletionRegistration: true,
    });
    expect(cfg.args).toEqual([
      join(__thisDir, 'quicksaveToolsMcpStdio.ts'),
      '--cwd', '/p',
      '--native-completion-registration',
    ]);
  });

  it('can inherit the MCP process cwd for workspace-scoped hosts', () => {
    const cfg = buildQuicksaveToolsMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/ignored',
      inheritCwd: true,
    });
    expect(cfg.args).toEqual([join(__thisDir, 'quicksaveToolsMcpStdio.ts')]);
  });

  it('falls back to node + .js when only the compiled file exists (prod)', () => {
    // Point at a directory that has no quicksaveToolsMcpStdio.{ts,js} — simulates prod
    // where only dist/ai/quicksaveToolsMcpStdio.js is shipped. We can't easily exercise
    // the real prod layout from a test, so verify by picking a dir without a .ts file.
    const emptyDir = join(__thisDir, '..'); // apps/agent/src — has no quicksaveToolsMcpStdio.ts
    const cfg = buildQuicksaveToolsMcpServerConfig({ ownDir: emptyDir, cwd: '/p' });
    expect(cfg.command).toBe('node');
    expect(cfg.args[0]).toBe(join(emptyDir, 'quicksaveToolsMcpStdio.js'));
  });

  it('uses canonical server name for the export', () => {
    expect(QUICKSAVE_MCP_NAME).toBe('quicksave-tools');
  });
});
