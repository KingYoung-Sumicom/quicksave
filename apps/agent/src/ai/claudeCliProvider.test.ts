// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildClaudeCliArgs,
  decorateModelWithContextWindow,
  CliProviderSession,
  ClaudeCliProvider,
} from './claudeCliProvider.js';
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
      // Interactive prompts and structural exits must always reach the user even in bypass mode.
      expect(cmd).toContain('AskUserQuestion');
      expect(cmd).toContain('ExitPlanMode');
      expect(cmd).toContain('ExitWorktree');
      expect(cmd).toContain('grep');
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

  describe('contextWindow → model suffix', () => {
    it('passes the bare model when contextWindow is 200k', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p', ownDir: __ownDir,
        model: 'claude-sonnet-4-6',
        contextWindow: 200_000,
      });
      expect(argValue(args, '--model')).toBe('claude-sonnet-4-6');
    });

    it('appends [1m] for 500k on a 1M-capable model', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p', ownDir: __ownDir,
        model: 'claude-sonnet-4-6',
        contextWindow: 500_000,
      });
      expect(argValue(args, '--model')).toBe('claude-sonnet-4-6[1m]');
    });

    it('appends [1m] for 1M on a 1M-capable model', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p', ownDir: __ownDir,
        model: 'claude-opus-4-7',
        contextWindow: 1_000_000,
      });
      expect(argValue(args, '--model')).toBe('claude-opus-4-7[1m]');
    });

    it('does not append [1m] for haiku regardless of contextWindow', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p', ownDir: __ownDir,
        model: 'claude-haiku-4-5-20251001',
        contextWindow: 1_000_000,
      });
      expect(argValue(args, '--model')).toBe('claude-haiku-4-5-20251001');
    });

    it('leaves an already-suffixed model alone', () => {
      const args = buildClaudeCliArgs({
        cwd: '/p', ownDir: __ownDir,
        model: 'claude-opus-4-7[1m]',
        contextWindow: 200_000,
      });
      // Caller already opted in — we don't strip it; the explicit choice wins.
      expect(argValue(args, '--model')).toBe('claude-opus-4-7[1m]');
    });
  });

  describe('reasoningEffort → --effort', () => {
    it('omits --effort when not provided', () => {
      const args = buildClaudeCliArgs({ cwd: '/p', ownDir: __ownDir });
      expect(args).not.toContain('--effort');
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
      'passes --effort %s through verbatim',
      (level) => {
        const args = buildClaudeCliArgs({
          cwd: '/p', ownDir: __ownDir,
          reasoningEffort: level,
        });
        expect(argValue(args, '--effort')).toBe(level);
      },
    );
  });
});

describe('decorateModelWithContextWindow', () => {
  it('returns undefined when no model is given', () => {
    expect(decorateModelWithContextWindow(undefined, 1_000_000)).toBeUndefined();
  });
  it('appends [1m] for >200k on sonnet/opus', () => {
    expect(decorateModelWithContextWindow('claude-sonnet-4-6', 500_000))
      .toBe('claude-sonnet-4-6[1m]');
    expect(decorateModelWithContextWindow('claude-opus-4-7', 1_000_000))
      .toBe('claude-opus-4-7[1m]');
  });
  it('returns the input unchanged at 200k', () => {
    expect(decorateModelWithContextWindow('claude-sonnet-4-6', 200_000))
      .toBe('claude-sonnet-4-6');
  });
  it('returns the input unchanged for haiku', () => {
    expect(decorateModelWithContextWindow('claude-haiku-4-5-20251001', 1_000_000))
      .toBe('claude-haiku-4-5-20251001');
  });
  it('does not double-append when the suffix is already present', () => {
    expect(decorateModelWithContextWindow('claude-opus-4-7[1m]', 1_000_000))
      .toBe('claude-opus-4-7[1m]');
  });
});

function mockProc() {
  return { killed: false, stdin: { write: vi.fn() }, kill: vi.fn() } as any;
}

describe('CliProviderSession.sendControlRequest wall-clock cap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects at the wall-clock cap even while a turn is active (idle clock paused)', async () => {
    vi.useFakeTimers();
    const session = new CliProviderSession(mockProc());
    // Simulate a tool call in flight: the idle timer must NOT advance.
    session.activeTurn = true;

    const pending = session.sendControlRequest('set_model', { model: 'x' }, 5_000, 5_000);
    const onReject = vi.fn();
    pending.catch(onReject);

    // 4s of wall time: under the 5s cap, still pending.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onReject).not.toHaveBeenCalled();

    // Cross the 5s wall cap — must reject despite activeTurn freezing the idle clock.
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).rejects.toThrow(/wall-clock/);
    // The pending entry is cleaned up so a late response can't double-resolve.
    expect(session.pendingControlResponses.size).toBe(0);
  });

  it('without a wall cap, an active turn keeps the request pending indefinitely', async () => {
    vi.useFakeTimers();
    const session = new CliProviderSession(mockProc());
    session.activeTurn = true;

    let settled = false;
    session.sendControlRequest('reload_plugins', undefined, 5_000).then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // Far beyond the idle timeout, but the idle clock is paused by activeTurn.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(session.pendingControlResponses.size).toBe(1);
  });
});

describe('CliProviderSession deferred permission mode', () => {
  // flushPendingPermissionMode → sendControlRequest starts a polling interval
  // that only clears on response/timeout; fake timers keep it from leaking.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushPendingPermissionMode writes set_permission_mode to stdin when idle', () => {
    vi.useFakeTimers();
    const proc = mockProc();
    const session = new CliProviderSession(proc);
    session.queuePermissionMode('plan');

    session.flushPendingPermissionMode();

    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const written = JSON.parse((proc.stdin.write as any).mock.calls[0][0].trim());
    expect(written.type).toBe('control_request');
    expect(written.request).toMatchObject({ subtype: 'set_permission_mode', mode: 'plan' });
  });

  it('flushPendingPermissionMode is a no-op when nothing is queued', () => {
    const proc = mockProc();
    const session = new CliProviderSession(proc);

    session.flushPendingPermissionMode();

    expect(proc.stdin.write).not.toHaveBeenCalled();
  });

  it('last queued mode wins', () => {
    vi.useFakeTimers();
    const proc = mockProc();
    const session = new CliProviderSession(proc);
    session.queuePermissionMode('plan');
    session.queuePermissionMode('acceptEdits');

    session.flushPendingPermissionMode();

    const written = JSON.parse((proc.stdin.write as any).mock.calls[0][0].trim());
    expect(written.request.mode).toBe('acceptEdits');
  });

  it('does not write when the process is dead', () => {
    const proc = mockProc();
    proc.killed = true;
    const session = new CliProviderSession(proc);
    session.queuePermissionMode('plan');

    session.flushPendingPermissionMode();

    expect(proc.stdin.write).not.toHaveBeenCalled();
  });
});

describe('routeMessage permission handling does not block the read loop', () => {
  it('returns immediately for can_use_tool even if the permission decision never resolves', async () => {
    const provider = new ClaudeCliProvider();
    const session = new CliProviderSession(mockProc());

    // handlePermissionRequest blocks forever — mirrors a user who walks away
    // mid-approval. The read loop must not await it, otherwise concurrent
    // control_responses (set_model / set_permission_mode) can never be routed.
    let decisionRequested = false;
    const callbacks: any = {
      handlePermissionRequest: vi.fn(() => {
        decisionRequested = true;
        return new Promise(() => {}); // never resolves
      }),
    };

    const msg = {
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'tu-1' },
    };

    const noop = () => {};
    const result = await Promise.race([
      (provider as any).routeMessage('sess', msg, session, {}, callbacks, noop, noop, noop, undefined),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 100)),
    ]);

    // routeMessage resolved on its own (false), not via the 100ms guard.
    expect(result).toBe(false);
    expect(decisionRequested).toBe(true);
  });
});
