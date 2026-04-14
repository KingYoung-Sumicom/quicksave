import type { AgentId, CodexModelInfo } from '@sumicom/quicksave-shared';

// Agent presets for quicksave session configuration
export const CLAUDE_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];

/** Fallback when dynamic model list isn't available */
export const CODEX_MODELS_FALLBACK = [
  { value: 'o4-mini', label: 'o4-mini' },
  { value: 'o3', label: 'o3' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
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
