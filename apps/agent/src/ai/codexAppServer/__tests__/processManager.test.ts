import { describe, expect, it, vi } from 'vitest';

import { checkSchemaVersionCompatibility } from '../processManager.js';
import { buildCodexSandboxMcpConfigArgs } from '../provider.js';

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
      'mcp_servers.quicksave-sandbox.tools.SandboxBash.approval_mode="approve"',
      '-c',
      'mcp_servers.quicksave-sandbox.tools.UpdateSessionStatus.approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.default_tools_approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.default_tools_enabled=true',
      '-c',
      'apps.quicksave-sandbox.destructive_enabled=true',
      '-c',
      'apps.quicksave-sandbox.open_world_enabled=true',
      '-c',
      'apps.quicksave-sandbox.tools.SandboxBash.approval_mode="approve"',
      '-c',
      'apps.quicksave-sandbox.tools.UpdateSessionStatus.approval_mode="approve"',
    ]);
    expect(args[3]).toContain('"--cwd"');
    expect(args[3]).toContain('"/tmp/project"');
    expect(args[3]).toContain('"--session-id"');
    expect(args[3]).toContain('"thr_123"');
  });
});
