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

/** Models whose 1M context window is *not* included in any subscription plan
 *  and would be billed to pay-as-you-go usage credits. Sonnet 1M falls here:
 *  unlike Opus (included on Pro/Max/Team/Enterprise since 2026-03-20), Sonnet
 *  1M always bills to credits, so enabling it silently would surprise the
 *  user. We gate it behind an explicit opt-in flag (`allowBilled`). */
const MODEL_1M_REQUIRES_CREDITS: RegExp[] = [/^claude-sonnet/i];

export interface ModelCapabilityOpts {
  /** True when the user has explicitly opted into having 1M-context requests
   *  billed to usage credits for models that aren't included in their plan
   *  (Sonnet 1M today). Default false. */
  allowBilled?: boolean;
}

/** Whether the model can be sent with the `context-1m-2025-08-07` beta given
 *  the user's billing opt-in.
 *   - Haiku: always false (model doesn't support the beta).
 *   - Sonnet: only when `allowBilled` is true (1M is not included in any
 *     plan and would consume usage credits).
 *   - Opus / everything else: true (Pro/Max/Team/Enterprise include 1M Opus). */
export function modelSupports1m(model: string, opts?: ModelCapabilityOpts): boolean {
  if (/^claude-haiku/i.test(model)) return false;
  if (MODEL_1M_REQUIRES_CREDITS.some((re) => re.test(model))) {
    return !!opts?.allowBilled;
  }
  return true;
}

export const CLAUDE_CONTEXT_WINDOWS: { value: number; label: string }[] = [
  { value: 200_000, label: '200k' },
  { value: 500_000, label: '500k' },
  { value: 1_000_000, label: '1M' },
];

/** Context-window options available for the given Claude model. Haiku is
 *  pinned to 200k; Sonnet is pinned to 200k unless the user has opted into
 *  billed 1M; Opus offers the full range. */
export function getContextWindowOptionsForModel(
  model: string | undefined,
  opts?: ModelCapabilityOpts,
) {
  if (!model || !modelSupports1m(model, opts)) {
    return CLAUDE_CONTEXT_WINDOWS.filter((w) => w.value <= 200_000);
  }
  return CLAUDE_CONTEXT_WINDOWS;
}

/** Coerce any persisted contextWindow to a value the model supports under the
 *  current `allowBilled` setting. Stale prefs (e.g. 1M left over from when
 *  Opus was selected, then user switched to Sonnet without the billed
 *  opt-in) get capped at 200k here. */
export function clampContextWindowForModel(
  model: string | undefined,
  contextWindow: number | undefined,
  opts?: ModelCapabilityOpts,
): number {
  const cw = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!model || !modelSupports1m(model, opts)) return 200_000;
  return cw;
}

/** Fallback when dynamic model list isn't available */
export const CODEX_MODELS_FALLBACK = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
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

export const OPENCODE_PERMISSION_MODES = [
  { value: 'default', label: 'Default' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

/** Claude Code's reasoning levels — values accepted by the Claude CLI's
 *  `--effort` flag and the SDK's `Options.effort` field. The CLI accepts
 *  five (`low`/`medium`/`high`/`xhigh`/`max`); the SDK's TS enum currently
 *  only declares four (no `xhigh`), but the runtime accepts it. */
export const REASONING_EFFORTS_CLAUDE = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
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

export type AgentType = {
  value: AgentId;
  label: string;
  description: string;
  allowedTools?: string[];  // undefined = all tools; [] = no tools
  systemPrompt?: string;
};

const VALID_AGENT_IDS = new Set<AgentId>(['claude-code', 'codex', 'opencode', 'pi']);

export function normalizeAgentId(agentId?: string): AgentId {
  if (agentId === 'codex-mcp') return 'codex';
  return VALID_AGENT_IDS.has(agentId as AgentId) ? (agentId as AgentId) : 'claude-code';
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
