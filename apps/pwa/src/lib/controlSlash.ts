// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import type { AgentId } from '@sumicom/quicksave-shared';

const CLAUDE_CODE_ONLY: readonly AgentId[] = ['claude-code'];
const CODEX_ONLY: readonly AgentId[] = ['codex'];

export type ControlSlashSubtype =
  | 'get_context_usage'
  | 'get_settings'
  | 'set_model'
  | 'set_permission_mode'
  | 'set_max_thinking_tokens'
  | 'interrupt'
  | 'mcp_status'
  | 'reload_plugins'
  | 'goal.get'
  | 'goal.pause'
  | 'goal.resume'
  | 'goal.clear'
  | 'goal.set';

export type ControlSlashParseResult =
  | {
      kind: 'command';
      subtype: ControlSlashSubtype;
      params?: Record<string, unknown>;
    }
  | {
      kind: 'invalid';
      error: string;
    };

export function parseControlSlash(input: string, agentId: AgentId): ControlSlashParseResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const goal = parseGoalSlash(trimmed);
  if (goal) return forAgents(goal, agentId, CODEX_ONLY, 'Goal commands are only supported for Codex sessions.');

  const claude = parseClaudeControlSlash(trimmed);
  if (claude) {
    return forAgents(
      claude,
      agentId,
      CLAUDE_CODE_ONLY,
      'This control command is only supported for Claude Code sessions.',
    );
  }

  return null;
}

function forAgents(
  result: ControlSlashParseResult,
  agentId: AgentId,
  supported: readonly AgentId[],
  error: string,
): ControlSlashParseResult {
  if (result.kind === 'invalid') return result;
  return supported.includes(agentId) ? result : { kind: 'invalid', error };
}

function parseGoalSlash(input: string): ControlSlashParseResult | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(input);
  if (!match) return null;

  const rest = (match[1] ?? '').trim();
  if (!rest || /^get$/i.test(rest) || /^status$/i.test(rest)) {
    return { kind: 'command', subtype: 'goal.get' };
  }

  const [rawVerb = '', ...rawArgs] = rest.split(/\s+/);
  const verb = rawVerb.toLowerCase();
  const args = rawArgs.join(' ').trim();

  switch (verb) {
    case 'pause':
      return args
        ? invalidGoalCommand()
        : { kind: 'command', subtype: 'goal.pause' };
    case 'resume':
    case 'active':
      return args
        ? invalidGoalCommand()
        : { kind: 'command', subtype: 'goal.resume' };
    case 'clear':
      return args
        ? invalidGoalCommand()
        : { kind: 'command', subtype: 'goal.clear' };
    case 'set': {
      if (!args) return { kind: 'invalid', error: 'Usage: /goal set <objective>' };
      return {
        kind: 'command',
        subtype: 'goal.set',
        params: { objective: args },
      };
    }
    default:
      return {
        kind: 'invalid',
        error: 'Usage: /goal, /goal pause, /goal resume, /goal clear, or /goal set <objective>',
      };
  }
}

function parseClaudeControlSlash(input: string): ControlSlashParseResult | null {
  const [, rawName = '', rawRest = ''] = /^\/([^\s]+)(?:\s+([\s\S]*))?$/i.exec(input) ?? [];
  const name = rawName.toLowerCase();
  const rest = rawRest.trim();

  switch (name) {
    case 'model':
      return rest
        ? { kind: 'command', subtype: 'set_model', params: { model: rest } }
        : { kind: 'invalid', error: 'Usage: /model <model>' };
    case 'permission':
    case 'permissions':
    case 'perm':
      return rest && !/\s/.test(rest)
        ? { kind: 'command', subtype: 'set_permission_mode', params: { mode: rest } }
        : { kind: 'invalid', error: 'Usage: /permission <mode>' };
    case 'thinking':
    case 'max-thinking':
      return parseThinkingTokens(rest);
    case 'context':
      return !rest || /^usage$/i.test(rest)
        ? { kind: 'command', subtype: 'get_context_usage' }
        : { kind: 'invalid', error: 'Usage: /context or /context usage' };
    case 'settings':
      return noArgs(rest, 'get_settings', 'Usage: /settings');
    case 'mcp':
      return !rest || /^status$/i.test(rest)
        ? { kind: 'command', subtype: 'mcp_status' }
        : { kind: 'invalid', error: 'Usage: /mcp or /mcp status' };
    case 'mcp-status':
      return noArgs(rest, 'mcp_status', 'Usage: /mcp-status');
    case 'reload':
      return !rest || /^plugins$/i.test(rest)
        ? { kind: 'command', subtype: 'reload_plugins' }
        : { kind: 'invalid', error: 'Usage: /reload or /reload plugins' };
    case 'reload-plugins':
      return noArgs(rest, 'reload_plugins', 'Usage: /reload-plugins');
    case 'interrupt':
      return noArgs(rest, 'interrupt', 'Usage: /interrupt');
    default:
      return null;
  }
}

function parseThinkingTokens(rest: string): ControlSlashParseResult {
  if (!/^\d+$/.test(rest)) return { kind: 'invalid', error: 'Usage: /thinking <tokens>' };
  const tokens = Number(rest);
  return Number.isSafeInteger(tokens) && tokens > 0
    ? { kind: 'command', subtype: 'set_max_thinking_tokens', params: { tokens } }
    : { kind: 'invalid', error: 'Thinking token budget must be a positive integer.' };
}

function noArgs(
  rest: string,
  subtype: ControlSlashSubtype,
  usage: string,
): ControlSlashParseResult {
  return rest ? { kind: 'invalid', error: usage } : { kind: 'command', subtype };
}

function invalidGoalCommand(): ControlSlashParseResult {
  return {
    kind: 'invalid',
    error: 'Goal command does not take extra arguments.',
  };
}
