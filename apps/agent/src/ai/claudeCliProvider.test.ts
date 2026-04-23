import { describe, it, expect } from 'vitest';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildClaudeCliArgs } from './claudeCliProvider.js';
import { SANDBOX_BASH_TOOL } from './sandboxMcp.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hookSettings(args: string[]): { hooks?: { PermissionRequest?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } } | undefined {
  const raw = argValue(args, '--settings');
  return raw ? JSON.parse(raw) : undefined;
}

describe('buildClaudeCliArgs', () => {
  describe('permission mode translation', () => {
    it('passes acceptEdits straight through', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'acceptEdits' });
      expect(argValue(args, '--permission-mode')).toBe('acceptEdits');
    });

    it('passes plan straight through', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'plan' });
      expect(argValue(args, '--permission-mode')).toBe('plan');
    });

    it('passes auto straight through', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'auto' });
      expect(argValue(args, '--permission-mode')).toBe('auto');
    });

    it('passes default straight through', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'default' });
      expect(argValue(args, '--permission-mode')).toBe('default');
    });

    it('translates bypassPermissions to default on the wire', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'bypassPermissions' });
      expect(argValue(args, '--permission-mode')).toBe('default');
      expect(args).not.toContain('bypassPermissions');
    });

    it('omits --permission-mode when not provided', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir });
      expect(args).not.toContain('--permission-mode');
    });
  });

  describe('PermissionRequest hooks', () => {
    it('injects no hooks by default', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'default' });
      expect(args).not.toContain('--settings');
    });

    it('injects no hook when permissionMode is bypassPermissions but no bypassFlagPath provided', () => {
      // bypass is now driven by the sentinel file indirection; without a path,
      // the CLI runs in plain default mode and permission requests flow
      // through the daemon's AUTO_APPROVE + prompt-tool path.
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, permissionMode: 'bypassPermissions' });
      expect(args).not.toContain('--settings');
    });

    it('injects a conditional universal hook when bypassFlagPath is provided', () => {
      const flagPath = '/run/quicksave/bypass/tok-1';
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, bypassFlagPath: flagPath });
      const entries = hookSettings(args)?.hooks?.PermissionRequest ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher).toBe('*');
      expect(entries[0].hooks[0].type).toBe('command');
      const cmd = entries[0].hooks[0].command;
      expect(cmd).toContain(`[ -f "${flagPath}" ]`);
      expect(cmd).toContain('"behavior":"allow"');
      // Falls through to the prompt-tool path when the sentinel is absent.
      expect(cmd).toContain('|| true');
    });

    it('escapes embedded double quotes in bypassFlagPath', () => {
      // Defensive — QUICKSAVE_DIR could theoretically contain a quote.
      const evil = '/tmp/qs"weird/tok';
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, bypassFlagPath: evil });
      const cmd = hookSettings(args)?.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command;
      expect(cmd).toContain('/tmp/qs\\"weird/tok');
    });

    it('injects the sandbox hook when sandboxed (without bypassFlagPath)', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, sandboxed: true, permissionMode: 'default' });
      const entries = hookSettings(args)?.hooks?.PermissionRequest ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher).toBe(SANDBOX_BASH_TOOL);
    });

    it('merges sandbox + bypass-sentinel hooks into a single --settings payload', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p',
        ownDir: __ownDir,
        sandboxed: true,
        bypassFlagPath: '/run/quicksave/bypass/tok-2',
      });
      const entries = hookSettings(args)?.hooks?.PermissionRequest ?? [];
      expect(entries).toHaveLength(2);
      const matchers = entries.map(e => e.matcher);
      expect(matchers).toContain(SANDBOX_BASH_TOOL);
      expect(matchers).toContain('*');
      expect(args.filter(a => a === '--settings')).toHaveLength(1);
    });
  });

  describe('base flags', () => {
    it('always passes the stream-json + permission-prompt-tool bootstrap flags', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir });
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--permission-prompt-tool');
      expect(args).toContain('stdio');
      expect(args).toContain('--replay-user-messages');
    });

    it('passes --resume when resumeSessionId is provided', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir, resumeSessionId: 'abc-123' });
      expect(argValue(args, '--resume')).toBe('abc-123');
    });
  });
});
