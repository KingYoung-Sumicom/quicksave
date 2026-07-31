// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { TOOL_COLORS, TOOL_VIEWS } from './registry';

describe('OpenCode built-in tool card registry', () => {
  it('has dedicated views and colors for every normalized OpenCode tool', () => {
    const names = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'Skill',
      'Agent',
      'TodoWrite',
      'AskUserQuestion',
      'LSP',
      'ApplyPatch',
      'ExitPlanMode',
      'ExternalDirectory',
      'list_mcp_resources',
      'list_mcp_resource_templates',
      'read_mcp_resource',
      'mcp__codex__list_mcp_resources',
      'mcp__codex__list_mcp_resource_templates',
      'mcp__codex__read_mcp_resource',
    ];
    for (const name of names) {
      expect(TOOL_VIEWS[name], `${name} view`).toBeDefined();
      expect(TOOL_COLORS[name], `${name} color`).toBeDefined();
    }
  });
});
