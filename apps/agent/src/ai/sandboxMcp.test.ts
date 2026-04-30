// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildSandboxMcpServerConfig, SANDBOX_MCP_NAME } from './sandboxMcp.js';

const __thisDir = dirname(fileURLToPath(import.meta.url));

describe('buildSandboxMcpServerConfig', () => {
  it('uses absolute tsx path when sandboxMcpStdio.ts is present (dev)', () => {
    // This test file lives next to sandboxMcpStdio.ts so the .ts branch is exercised.
    const cfg = buildSandboxMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/some/project',
    });

    expect(cfg.type).toBe('stdio');
    expect(cfg.command).toBe(join(__thisDir, '..', '..', 'node_modules', '.bin', 'tsx'));
    expect(cfg.args[0]).toBe(join(__thisDir, 'sandboxMcpStdio.ts'));
    expect(cfg.args.slice(1)).toEqual(['--cwd', '/some/project']);
  });

  it('appends --session-id when provided', () => {
    const cfg = buildSandboxMcpServerConfig({
      ownDir: __thisDir,
      cwd: '/p',
      sessionId: 'abc-123',
    });
    expect(cfg.args).toEqual([
      join(__thisDir, 'sandboxMcpStdio.ts'),
      '--cwd', '/p',
      '--session-id', 'abc-123',
    ]);
  });

  it('falls back to node + .js when only the compiled file exists (prod)', () => {
    // Point at a directory that has no sandboxMcpStdio.{ts,js} — simulates prod
    // where only dist/ai/sandboxMcpStdio.js is shipped. We can't easily exercise
    // the real prod layout from a test, so verify by picking a dir without a .ts file.
    const emptyDir = join(__thisDir, '..'); // apps/agent/src — has no sandboxMcpStdio.ts
    const cfg = buildSandboxMcpServerConfig({ ownDir: emptyDir, cwd: '/p' });
    expect(cfg.command).toBe('node');
    expect(cfg.args[0]).toBe(join(emptyDir, 'sandboxMcpStdio.js'));
  });

  it('uses canonical server name for the export', () => {
    expect(SANDBOX_MCP_NAME).toBe('quicksave-sandbox');
  });
});
