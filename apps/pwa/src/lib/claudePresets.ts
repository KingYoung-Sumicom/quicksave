// Agent presets for quicksave session configuration
export const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];

export const PERMISSION_MODES = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'plan', label: 'Plan Only' },
];

export type AgentType = {
  value: string;
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
  // TODO: Codex (OpenAI), Jules (Google)
];
