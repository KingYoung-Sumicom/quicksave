// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { parseControlSlash } from './controlSlash';

describe('parseControlSlash', () => {
  it('returns null for non-control prompts', () => {
    expect(parseControlSlash('/compact', 'claude-code')).toBeNull();
    expect(parseControlSlash('please /goal pause', 'codex')).toBeNull();
  });

  it('maps Codex goal forms to goal control requests', () => {
    expect(parseControlSlash('/goal', 'codex')).toEqual({ kind: 'command', subtype: 'goal.get' });
    expect(parseControlSlash('  /GOAL status  ', 'codex')).toEqual({ kind: 'command', subtype: 'goal.get' });
    expect(parseControlSlash('/goal pause', 'codex')).toEqual({ kind: 'command', subtype: 'goal.pause' });
    expect(parseControlSlash('/goal resume', 'codex')).toEqual({ kind: 'command', subtype: 'goal.resume' });
    expect(parseControlSlash('/goal active', 'codex')).toEqual({ kind: 'command', subtype: 'goal.resume' });
    expect(parseControlSlash('/goal clear', 'codex')).toEqual({ kind: 'command', subtype: 'goal.clear' });
    expect(parseControlSlash('/goal set Ship the fix', 'codex')).toEqual({
      kind: 'command',
      subtype: 'goal.set',
      params: { objective: 'Ship the fix' },
    });
  });

  it('rejects invalid Codex goal commands instead of passing them to the model', () => {
    expect(parseControlSlash('/goal pause now', 'codex')).toMatchObject({ kind: 'invalid' });
    expect(parseControlSlash('/goal later', 'codex')).toMatchObject({ kind: 'invalid' });
    expect(parseControlSlash('/goal set', 'codex')).toMatchObject({ kind: 'invalid' });
  });

  it('does not run goal commands on non-Codex sessions', () => {
    expect(parseControlSlash('/goal pause', 'claude-code')).toEqual({
      kind: 'invalid',
      error: 'Goal commands are only supported for Codex sessions.',
    });
  });

  it('maps Claude Code UI-backed controls', () => {
    expect(parseControlSlash('/model claude-opus-4-8', 'claude-code')).toEqual({
      kind: 'command',
      subtype: 'set_model',
      params: { model: 'claude-opus-4-8' },
    });
    expect(parseControlSlash('/permission plan', 'claude-code')).toEqual({
      kind: 'command',
      subtype: 'set_permission_mode',
      params: { mode: 'plan' },
    });
    expect(parseControlSlash('/thinking 8000', 'claude-code')).toEqual({
      kind: 'command',
      subtype: 'set_max_thinking_tokens',
      params: { tokens: 8000 },
    });
    expect(parseControlSlash('/context', 'claude-code')).toEqual({ kind: 'command', subtype: 'get_context_usage' });
    expect(parseControlSlash('/context usage', 'claude-code')).toEqual({ kind: 'command', subtype: 'get_context_usage' });
    expect(parseControlSlash('/settings', 'claude-code')).toEqual({ kind: 'command', subtype: 'get_settings' });
    expect(parseControlSlash('/mcp status', 'claude-code')).toEqual({ kind: 'command', subtype: 'mcp_status' });
    expect(parseControlSlash('/mcp-status', 'claude-code')).toEqual({ kind: 'command', subtype: 'mcp_status' });
    expect(parseControlSlash('/reload plugins', 'claude-code')).toEqual({ kind: 'command', subtype: 'reload_plugins' });
    expect(parseControlSlash('/reload-plugins', 'claude-code')).toEqual({ kind: 'command', subtype: 'reload_plugins' });
    expect(parseControlSlash('/interrupt', 'claude-code')).toEqual({ kind: 'command', subtype: 'interrupt' });
  });

  it('rejects malformed Claude Code controls', () => {
    expect(parseControlSlash('/model', 'claude-code')).toMatchObject({ kind: 'invalid' });
    expect(parseControlSlash('/permission plan now', 'claude-code')).toMatchObject({ kind: 'invalid' });
    expect(parseControlSlash('/thinking many', 'claude-code')).toMatchObject({ kind: 'invalid' });
    expect(parseControlSlash('/context now', 'claude-code')).toMatchObject({ kind: 'invalid' });
  });

  it('does not run Claude Code controls on other providers', () => {
    expect(parseControlSlash('/model gpt-5.3-codex', 'codex')).toEqual({
      kind: 'invalid',
      error: 'This control command is only supported for Claude Code sessions.',
    });
  });
});
