// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId } from '@sumicom/quicksave-shared';

import { SANDBOX_BASH_TOOL, UPDATE_SESSION_STATUS_TOOL } from './sandboxMcp.js';

const STATUS_PROMPT = [
  '## Session Status Tool — MUST use every session',
  'The session status tool is pre-loaded. You MUST call it before doing any other work.',
  '',
  '### New session (first response)',
  '- Call immediately with `subject` + `stage`. Do NOT start coding or researching first.',
  '- `subject`: what the user is solving (e.g. "Fix auth token expiring early"). NOT what you are doing (NOT "Debugging jwt.ts").',
  '- `stage`: one of `investigating`, `working`, `verifying`, `done`.',
  '',
  '### Resume (existing session)',
  '- If you do NOT see a prior status tool call in conversation history: call with NO fields first (dry-run).',
  '- If dry-run returns empty subject OR a subject that does not match the current request: follow up with a real call to set/correct it.',
  '',
  '### Stage transitions',
  '- Re-call whenever stage changes: `investigating` → `working` → `verifying` → `done`.',
  '- Set `blocked: true` when stuck (waiting on user, permission, external service). Set `blocked: false` when unblocked. Do NOT change stage when toggling blocked.',
  '- Emit a one-line `note` (~12 words) on meaningful state changes: ruling out an approach, completing a sub-goal, hitting a blocker. Notes are APPENDED, never overwritten.',
  '',
  '### Rules',
  '- Do NOT skip `verifying` when you ran tests / build / repro.',
  '- Do NOT declare `done` until the user\'s problem is fully resolved.',
  '- For long-running tasks, set `pendingMissionLabel` + `pendingMissionUntil`. Clear with `clearPendingMission: true` when finished. `stage: "done"` also clears it.',
  '- For long refactors, prefer proposing per-phase sub-sessions over staying in `investigating` indefinitely.',
].join('\n');

const COMMIT_TRAILER_PROMPT =
  'When you create git commits in a quicksave session, add `Co-Authored-By: Quicksave AI <save@quicksave.dev>` as a co-author trailer alongside whatever your platform default already adds (e.g. `Co-Authored-By: Claude ...`). Quicksave is the spawning context and should be credited in addition to — not instead of — the underlying model. Both trailers, one per line, after a blank line below the body.';

const PLATFORM_PROMPTS: Partial<Record<AgentId, string[]>> = {
  'claude-code': [
    `# Required tools`,
    `## 1. Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`,
    `## 2. SandboxBash: prefer over Bash for read-only commands (ls, cat, find, git log, git status, git diff).`,
    STATUS_PROMPT,
    COMMIT_TRAILER_PROMPT,
  ],
  codex: [
    `# Required tools`,
    `## 1. Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`,
    `## 2. SandboxBash: prefer the \`${SANDBOX_BASH_TOOL}\` MCP tool for read-only commands.`,
    STATUS_PROMPT,
    COMMIT_TRAILER_PROMPT,
  ],
  opencode: [
    `# Required tools`,
    `## 1. Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`,
    `## 2. SandboxBash: prefer the \`${SANDBOX_BASH_TOOL}\` MCP tool for read-only commands.`,
    STATUS_PROMPT,
    COMMIT_TRAILER_PROMPT,
  ],
};

const FALLBACK_PROMPTS = [
  `# Required tools`,
  `## 1. Session status tool: \`${UPDATE_SESSION_STATUS_TOOL}\` — MUST call on first response`,
  STATUS_PROMPT,
  COMMIT_TRAILER_PROMPT,
];

export function buildSystemPrompt(agentId: AgentId, extra?: string): string {
  const base = (PLATFORM_PROMPTS[agentId] ?? FALLBACK_PROMPTS).join('\n\n');
  return extra ? `${base}\n\n${extra}` : base;
}
