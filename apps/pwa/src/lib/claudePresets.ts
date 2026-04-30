// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, CodexModelInfo } from '@sumicom/quicksave-shared';
import { DEFAULT_CONTEXT_WINDOW } from '@sumicom/quicksave-shared';

// Agent presets for quicksave session configuration. Context window is a
// separate axis (see CLAUDE_CONTEXT_WINDOWS / getContextWindowOptionsForModel)
// — the agent appends `[1m]` to the model on the wire when the user picks
// >200k, and exports CLAUDE_CODE_AUTO_COMPACT_WINDOW so the CLI compacts at
// the chosen ceiling regardless of which tier the API would otherwise use.
export const CLAUDE_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
];

/** Identifies the Claude models that don't support the `context-1m-2025-08-07`
 *  beta. Today only Haiku is locked to 200k; everything else opts into 1M. */
export function modelSupports1m(model: string): boolean {
  return !/^claude-haiku/i.test(model);
}

export const CLAUDE_CONTEXT_WINDOWS: { value: number; label: string }[] = [
  { value: 200_000, label: '200k' },
  { value: 500_000, label: '500k' },
  { value: 1_000_000, label: '1M' },
];

/** Context-window options available for the given Claude model. Haiku is
 *  pinned to 200k; everything else can opt up to 500k or 1M. */
export function getContextWindowOptionsForModel(model: string | undefined) {
  if (!model || !modelSupports1m(model)) {
    return CLAUDE_CONTEXT_WINDOWS.filter((w) => w.value <= 200_000);
  }
  return CLAUDE_CONTEXT_WINDOWS;
}

/** Coerce any persisted contextWindow to a value the model supports. Older
 *  prefs may carry 1M for a model that's since been rolled back to 200k. */
export function clampContextWindowForModel(
  model: string | undefined,
  contextWindow: number | undefined,
): number {
  const cw = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!model || !modelSupports1m(model)) return 200_000;
  return cw;
}

/** Fallback when dynamic model list isn't available */
export const CODEX_MODELS_FALLBACK = [
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
];

/** @deprecated Use CLAUDE_MODELS instead */
export const MODELS = CLAUDE_MODELS;

/** Convert dynamic CodexModelInfo[] to button group options */
export function codexModelsToOptions(models: CodexModelInfo[]): { value: string; label: string }[] {
  return models.map((m) => ({ value: m.id, label: m.name }));
}

export function getModelsForAgent(agentId: AgentId, dynamicCodexModels?: CodexModelInfo[]) {
  if (agentId === 'codex') {
    return dynamicCodexModels?.length
      ? codexModelsToOptions(dynamicCodexModels)
      : CODEX_MODELS_FALLBACK;
  }
  return CLAUDE_MODELS;
}

export const PERMISSION_MODES = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'plan', label: 'Plan Only' },
  { value: 'auto', label: 'Auto' },
];

/** Codex permission presets that match the Codex app's labels.
 *  Each preset bundles (approval_policy, sandbox_mode) — the Codex docs call
 *  these "common sandbox and approval combinations". Source:
 *  https://developers.openai.com/codex/agent-approvals-security
 *
 *  The agent expands the preset id back into the SDK's two axes:
 *    read-only   → (on-request, read-only)
 *    default     → (on-request, workspace-write)        [app: 預設]
 *    auto-review → (on-request, workspace-write) +      [app: 自動審核]
 *                  config `approvals_reviewer = auto_review`
 *    full-access → (never, danger-full-access)          [app: 完整存取權] */
export const CODEX_PERMISSION_MODES = [
  { value: 'read-only',   label: 'Read Only' },
  { value: 'default',     label: 'Default' },
  { value: 'auto-review', label: 'Auto Review' },
  { value: 'full-access', label: 'Full Access' },
];

export function getPermissionModesForAgent(agentId: AgentId) {
  return agentId === 'codex' ? CODEX_PERMISSION_MODES : PERMISSION_MODES;
}

/** Claude Code's reasoning levels — these are the values the Claude CLI's
 *  `thinking_budget` (or equivalent) accepts. Distinct enum from Codex's. */
export const REASONING_EFFORTS_CLAUDE = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

/** Codex SDK's `ModelReasoningEffort` union, used as fallback when a model
 *  isn't in the dynamic list (so the chip still has something to render). */
export const REASONING_EFFORTS_CODEX_FALLBACK = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

/** Build the reasoning-effort dropdown for the current agent + model.
 *  Claude uses a fixed enum; Codex prefers the per-model
 *  `supported_reasoning_levels` and falls back to its SDK union. */
export function getReasoningEffortsForModel(
  agentId: AgentId,
  modelId: string | undefined,
  dynamicCodexModels?: CodexModelInfo[],
) {
  if (agentId !== 'codex') return REASONING_EFFORTS_CLAUDE;
  const model = dynamicCodexModels?.find((m) => m.id === modelId);
  const efforts = model?.reasoningEfforts;
  if (!efforts || efforts.length === 0) return REASONING_EFFORTS_CODEX_FALLBACK;
  return efforts.map((e) => ({
    value: e,
    label: e === 'xhigh' ? 'X-High' : e[0].toUpperCase() + e.slice(1),
  }));
}

export type AgentType = {
  value: AgentId;
  label: string;
  description: string;
  allowedTools?: string[];  // undefined = all tools; [] = no tools
  systemPrompt?: string;
};

export const AGENT_TYPES: AgentType[] = [
  {
    value: 'claude-code',
    label: 'Claude Code',
    description: 'Full tool access — reads, edits, runs code',
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex via MCP server',
  },
];

export function normalizeAgentId(agentId?: string): AgentId {
  return agentId === 'codex' || agentId === 'codex-mcp' ? 'codex' : 'claude-code';
}

export function getAgentType(agentId: AgentId): AgentType {
  return AGENT_TYPES.find((agent) => agent.value === agentId) ?? AGENT_TYPES[0];
}

/**
 * Max context window (tokens) for the badge / progress bar.
 * Resolution order:
 *   1. Session-scoped `contextWindow` config (200k / 500k / 1M) — set by the
 *      ClaudeSettingsSection picker. Authoritative when present.
 *   2. Legacy `[1m]` suffix on the model string (kept for backwards-compat
 *      until older session configs are migrated).
 *   3. Codex per-model context advertised by the daemon.
 *   4. 200k fallback so the bar still renders for unknown ids.
 */
export function getModelContextLimit(
  model?: string,
  dynamicCodexModels?: CodexModelInfo[],
  sessionContextWindow?: number,
): number {
  if (sessionContextWindow && sessionContextWindow > 0) return sessionContextWindow;
  if (!model) return 200_000;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  const codexMatch = dynamicCodexModels?.find((m) => m.id === model);
  if (codexMatch?.contextWindow) return codexMatch.contextWindow;
  return 200_000;
}
