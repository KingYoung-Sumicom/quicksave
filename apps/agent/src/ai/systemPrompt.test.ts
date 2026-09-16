// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { UPDATE_SESSION_STATUS_TOOL } from './quicksaveToolsMcp.js';
import { buildSystemPrompt } from './systemPrompt.js';

describe('buildSystemPrompt', () => {
  it('requires the renamed session status MCP tool for Claude', () => {
    const prompt = buildSystemPrompt('claude-code');
    expect(prompt).toContain(`Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`);
    expect(prompt).not.toContain('SandboxBash');
  });

  it('requires the renamed session status MCP tool for Codex', () => {
    const prompt = buildSystemPrompt('codex');
    expect(prompt).toContain(`Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`);
    expect(prompt).not.toContain('SandboxBash');
  });

  it('appends caller-provided instructions', () => {
    expect(buildSystemPrompt('codex', 'extra instruction')).toContain('\n\nextra instruction');
  });

  it('instructs every agent to add the Quicksave AI commit trailer alongside the platform default', () => {
    for (const agent of ['claude-code', 'codex'] as const) {
      const prompt = buildSystemPrompt(agent);
      expect(prompt).toContain('Co-Authored-By: Quicksave AI <save@quicksave.dev>');
      expect(prompt).toContain('alongside');
      expect(prompt).toContain('in addition to');
    }
  });
});
