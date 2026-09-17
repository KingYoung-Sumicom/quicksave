// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useSessionStore } from '../stores/sessionStore';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';
import { normalizeAgentId } from '../lib/agentPresets';

/**
 * Returns the runtime config for an active session.
 * Falls back to new-session defaults from the store when sessionId is null.
 */
export function useSessionConfig(sessionId: string | null): Record<string, ConfigValue> {
  const sessionConfigs = useSessionStore((s) => s.sessionConfigs);
  const selectedModel = useSessionStore((s) => s.selectedModel);
  const selectedAgent = useSessionStore((s) => s.selectedAgent);
  const selectedPermissionMode = useSessionStore((s) => s.selectedPermissionMode);
  const selectedReasoningEffort = useSessionStore((s) => s.selectedReasoningEffort);
  const selectedFastMode = useSessionStore((s) => s.selectedFastMode);
  const sandboxEnabled = useSessionStore((s) => s.sandboxEnabled);
  const selectedContextWindow = useSessionStore((s) => s.selectedContextWindow);

  if (!sessionId) {
    // New session — return store defaults (falling back to shared defaults)
    return {
      agent: selectedAgent ?? DEFAULT_AGENT,
      model: selectedModel ?? DEFAULT_MODEL,
      permissionMode: selectedPermissionMode ?? DEFAULT_PERMISSION_MODE,
      reasoningEffort: selectedReasoningEffort ?? DEFAULT_REASONING_EFFORT,
      fastMode: selectedFastMode,
      sandboxed: sandboxEnabled,
      contextWindow: selectedContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  }

  const sessionConfig = sessionConfigs[sessionId] ?? {};
  const rawSessionAgent = (sessionConfig['agent'] as string | undefined)
    ?? (((sessionConfig as Record<string, ConfigValue>)['provider']) as string | undefined);
  const sessionAgent = rawSessionAgent ? normalizeAgentId(rawSessionAgent) : undefined;

  // Active session — merge defaults with session-specific overrides
  const merged: Record<string, ConfigValue> = {
    agent: selectedAgent ?? DEFAULT_AGENT,
    model: selectedModel,
    permissionMode: selectedPermissionMode,
    reasoningEffort: selectedReasoningEffort,
    fastMode: selectedFastMode,
    sandboxed: sandboxEnabled,
    contextWindow: selectedContextWindow,
    ...sessionConfig,
    ...(sessionAgent ? { agent: sessionAgent } : {}),
  };
  // OpenCode has no separate bypass state — `--yolo` is a hidden alias of
  // `--auto`. Sessions persisted under the old "Bypass" label keep showing
  // the matching (Yolo) chip instead of a value with no preset option.
  if (merged.agent === 'opencode' && merged.permissionMode === 'bypassPermissions') {
    merged.permissionMode = 'auto';
  }
  return merged;
}
