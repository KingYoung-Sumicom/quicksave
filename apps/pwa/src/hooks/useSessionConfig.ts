import { useClaudeStore } from '../stores/claudeStore';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';

/**
 * Returns the runtime config for an active session.
 * Falls back to new-session defaults from the store when sessionId is null.
 */
export function useSessionConfig(sessionId: string | null): Record<string, ConfigValue> {
  const sessionConfigs = useClaudeStore((s) => s.sessionConfigs);
  const selectedModel = useClaudeStore((s) => s.selectedModel);
  const selectedAgent = useClaudeStore((s) => s.selectedAgent);
  const selectedPermissionMode = useClaudeStore((s) => s.selectedPermissionMode);
  const selectedReasoningEffort = useClaudeStore((s) => s.selectedReasoningEffort);
  const sandboxEnabled = useClaudeStore((s) => s.sandboxEnabled);
  const selectedContextWindow = useClaudeStore((s) => s.selectedContextWindow);

  if (!sessionId) {
    // New session — return store defaults (falling back to shared defaults)
    return {
      agent: selectedAgent ?? DEFAULT_AGENT,
      model: selectedModel ?? DEFAULT_MODEL,
      permissionMode: selectedPermissionMode ?? DEFAULT_PERMISSION_MODE,
      reasoningEffort: selectedReasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxed: sandboxEnabled,
      contextWindow: selectedContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  }

  const sessionConfig = sessionConfigs[sessionId] ?? {};
  const rawSessionAgent = (sessionConfig['agent'] as string | undefined)
    ?? (((sessionConfig as Record<string, ConfigValue>)['provider']) as string | undefined);
  const sessionAgent = rawSessionAgent
    ? (rawSessionAgent === 'codex' || rawSessionAgent === 'codex-mcp' ? 'codex' : 'claude-code')
    : undefined;

  // Active session — merge defaults with session-specific overrides
  return {
    agent: selectedAgent ?? DEFAULT_AGENT,
    model: selectedModel,
    permissionMode: selectedPermissionMode,
    reasoningEffort: selectedReasoningEffort,
    sandboxed: sandboxEnabled,
    contextWindow: selectedContextWindow,
    ...sessionConfig,
    ...(sessionAgent ? { agent: sessionAgent } : {}),
  };
}
