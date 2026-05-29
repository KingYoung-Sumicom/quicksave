// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId } from '@sumicom/quicksave-shared';

/**
 * Short product names surfaced as a neutral text chip in session lists —
 * intentionally no official logos, to stay clear of Anthropic/OpenAI brand
 * guidelines. Labels are nominative use and not translated.
 *
 * Both Claude providers are surfaced distinctly so the session list can tell
 * a `claude-code` session apart from a `claude-terminal` (TUI) one — they
 * otherwise look identical in the list.
 */
export const AGENT_LABEL: Partial<Record<AgentId, string>> = {
  'claude-code': 'Claude',
  'claude-terminal': 'Claude TUI',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};
