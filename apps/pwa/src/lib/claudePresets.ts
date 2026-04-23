import type { AgentId, CodexModelInfo } from '@sumicom/quicksave-shared';

// Agent presets for quicksave session configuration
// Append [1m] to enable the 1M context window (Claude Code strips the suffix before API calls).
// Without [1m], models default to 200k context.
export const CLAUDE_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)' },
];

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
 * Max context window (tokens) for a given model string.
 * Claude default = 200k; `[1m]` suffix enables 1M context window.
 * Codex/o-series fall back to 200k for a reasonable display.
 */
export function getModelContextLimit(model?: string): number {
  if (!model) return 200_000;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  return 200_000;
}
