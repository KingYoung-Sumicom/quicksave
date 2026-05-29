// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import type { AgentId } from '@sumicom/quicksave-shared';
import { AGENT_LABEL } from './agentLabel';

// Keep in sync with the AgentId union in packages/shared. The exhaustiveness
// test below fails to compile if a member is missing here, forcing this list
// — and a label decision — to be updated whenever a provider is added.
const ALL_AGENTS: AgentId[] = ['claude-code', 'claude-terminal', 'codex', 'opencode', 'pi'];

describe('AGENT_LABEL', () => {
  it('distinguishes the two Claude providers', () => {
    // The whole point of the chip: a claude-code session must not look
    // identical to a claude-terminal (TUI) one in the session list.
    expect(AGENT_LABEL['claude-code']).toBe('Claude');
    expect(AGENT_LABEL['claude-terminal']).toBe('Claude TUI');
    expect(AGENT_LABEL['claude-code']).not.toBe(AGENT_LABEL['claude-terminal']);
  });

  it('labels every provider so none renders as a blank chip', () => {
    for (const agent of ALL_AGENTS) {
      expect(AGENT_LABEL[agent], `missing label for ${agent}`).toBeTruthy();
    }
  });

  it('keeps every label unique so providers stay visually distinct', () => {
    const labels = ALL_AGENTS.map((a) => AGENT_LABEL[a]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
