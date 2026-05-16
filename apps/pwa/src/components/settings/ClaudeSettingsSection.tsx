// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { AGENT_TYPES, getAgentProvider } from '../../lib/agentProvider';
import { normalizeAgentId } from '../../lib/claudePresets';
import { ButtonGroup } from '../ui/ButtonGroup';

interface ClaudeSettingsSectionProps {
  /** Session ID — null means new session (shows defaults, changes update store only) */
  sessionId: string | null;
  /** Called for any config key change on an active session */
  onSetConfig?: (key: string, value: ConfigValue) => void;
  /** When true, the agent selector is read-only (e.g. active session) */
  agentLocked?: boolean;
  /** Hide specific fields (useful when drawer delegates them to status bar) */
  hideFields?: Array<'agent' | 'model' | 'permission' | 'reasoningEffort' | 'sandbox' | 'contextWindow'>;
}

export function ClaudeSettingsSection({ sessionId, onSetConfig, agentLocked, hideFields = [] }: ClaudeSettingsSectionProps) {
  const hide = new Set(hideFields);
  const config = useSessionConfig(sessionId);
  const codexModels = useConnectionStore((s) => s.codexModels);

  const rawAgent = (config['agent'] as string | undefined) ?? (config['provider'] as string | undefined);
  const selectedAgent = rawAgent ? normalizeAgentId(rawAgent) : DEFAULT_AGENT;
  const provider = getAgentProvider(selectedAgent);
  const opencodeModels = useConnectionStore((s) => s.opencodeModels);
  const dynamic = { codexModels, opencodeModels };

  // Build values map from session config with sensible defaults
  const values: Record<string, unknown> = {
    model: (config['model'] as string | undefined) ?? DEFAULT_MODEL,
    permissionMode: (config['permissionMode'] as string | undefined) ?? DEFAULT_PERMISSION_MODE,
    reasoningEffort: (config['reasoningEffort'] as string | undefined) ?? DEFAULT_REASONING_EFFORT,
    sandbox: (config['sandboxed'] as boolean | undefined) ?? false,
    contextWindow: (config['contextWindow'] as number | undefined) ?? DEFAULT_CONTEXT_WINDOW,
  };

  // Map setting keys to session config keys (sandbox → sandboxed on the wire)
  const onChange = (key: string, value: unknown) => {
    const wireKey = key === 'sandbox' ? 'sandboxed' : key;
    onSetConfig?.(wireKey, value as ConfigValue);
  };

  // Build hideKeys from hideFields mapping
  const hideKeys: string[] = [];
  if (hide.has('model')) hideKeys.push('model');
  if (hide.has('permission')) hideKeys.push('permissionMode');
  if (hide.has('reasoningEffort')) hideKeys.push('reasoningEffort');
  if (hide.has('sandbox')) hideKeys.push('sandbox');
  if (hide.has('contextWindow')) hideKeys.push('contextWindow');

  return (
    <div className="space-y-5">
      {!hide.has('agent') && (
        <ButtonGroup
          label="Agent"
          options={AGENT_TYPES}
          value={selectedAgent}
          onSelect={agentLocked ? undefined : (agent) => onSetConfig?.('agent', agent.value)}
          disabled={agentLocked}
        />
      )}

      {provider.renderSettings(values, onChange, {
        mode: 'active-session',
        dynamic,
        hideKeys,
        sessionId,
      })}

      <CodexPendingHint sessionId={sessionId} isCodexAgent={selectedAgent === 'codex'} />
    </div>
  );
}

function CodexPendingHint({
  sessionId,
  isCodexAgent,
}: {
  sessionId: string | null;
  isCodexAgent: boolean;
}) {
  const isStreaming = useClaudeStore((s) =>
    sessionId ? !!s.sessions[sessionId]?.isStreaming : false,
  );
  if (!isCodexAgent || !sessionId || !isStreaming) return null;
  return (
    <p className="text-xs text-amber-300/80 leading-snug">
      Codex is mid-turn. Changes apply on the next prompt — interrupt the current
      turn if you want them to take effect immediately.
    </p>
  );
}
