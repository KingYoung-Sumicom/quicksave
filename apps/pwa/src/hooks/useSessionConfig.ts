import { useClaudeStore } from '../stores/claudeStore';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';

/**
 * Returns the runtime config for an active session.
 * Falls back to new-session defaults from the store when sessionId is null.
 */
export function useSessionConfig(sessionId: string | null): Record<string, ConfigValue> {
  const sessionConfigs = useClaudeStore((s) => s.sessionConfigs);
  const selectedModel = useClaudeStore((s) => s.selectedModel);
  const selectedPermissionMode = useClaudeStore((s) => s.selectedPermissionMode);
  const selectedReasoningEffort = useClaudeStore((s) => s.selectedReasoningEffort);

  if (!sessionId) {
    // New session — return store defaults (falling back to shared defaults)
    return {
      model: selectedModel ?? DEFAULT_MODEL,
      permissionMode: selectedPermissionMode ?? DEFAULT_PERMISSION_MODE,
      reasoningEffort: selectedReasoningEffort ?? DEFAULT_REASONING_EFFORT,
    };
  }

  // Active session — merge defaults with session-specific overrides
  return {
    model: selectedModel,
    permissionMode: selectedPermissionMode,
    reasoningEffort: selectedReasoningEffort,
    ...sessionConfigs[sessionId],
  };
}
