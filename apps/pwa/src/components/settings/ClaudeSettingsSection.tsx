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
import {
  AGENT_TYPES,
  clampContextWindowForModel,
  getContextWindowOptionsForModel,
  getModelsForAgent,
  getPermissionModesForAgent,
  getReasoningEffortsForModel,
} from '../../lib/claudePresets';
import { ButtonGroup } from '../ui/ButtonGroup';
import { ToggleSwitch } from '../ui/ToggleSwitch';

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
  const selectedAgent = rawAgent
    ? (rawAgent === 'codex' || rawAgent === 'codex-mcp' ? 'codex' : 'claude-code')
    : DEFAULT_AGENT;
  const selectedModel = (config['model'] as string | undefined) ?? DEFAULT_MODEL;
  const selectedPermissionMode = (config['permissionMode'] as string | undefined) ?? DEFAULT_PERMISSION_MODE;
  const selectedReasoningEffort = (config['reasoningEffort'] as string | undefined) ?? DEFAULT_REASONING_EFFORT;
  const sandboxed = (config['sandboxed'] as boolean | undefined) ?? false;
  const contextWindowRaw = (config['contextWindow'] as number | undefined) ?? DEFAULT_CONTEXT_WINDOW;

  const isClaudeAgent = selectedAgent === 'claude-code';
  const isCodexAgent = selectedAgent === 'codex';
  const models = getModelsForAgent(selectedAgent, codexModels);
  const supportsReasoning = isClaudeAgent
    ? selectedModel.startsWith('claude-')
    : isCodexAgent;
  const reasoningOptions = getReasoningEffortsForModel(selectedAgent, selectedModel, codexModels);
  const permissionOptions = getPermissionModesForAgent(selectedAgent);
  // Context window only matters for Claude Code; Codex uses its own per-model
  // window. Clamp the displayed value so picking Haiku after Sonnet/Opus
  // 1M doesn't leave the picker showing a setting the model can't honor.
  const contextWindowOptions = isClaudeAgent
    ? getContextWindowOptionsForModel(selectedModel)
    : [];
  const selectedContextWindow = clampContextWindowForModel(selectedModel, contextWindowRaw);

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

      {!hide.has('model') && (
        <ButtonGroup
          label="Model"
          options={models}
          value={selectedModel}
          onSelect={(m) => {
            onSetConfig?.('model', m.value);
            // Re-clamp contextWindow when switching to a model that doesn't
            // support the previously chosen tier (e.g. Sonnet 1M → Haiku).
            // Without this, the daemon would keep CLAUDE_CODE_AUTO_COMPACT_WINDOW
            // at 1M for a model the API would refuse it on.
            if (selectedAgent === 'claude-code') {
              const clamped = clampContextWindowForModel(m.value, contextWindowRaw);
              if (clamped !== contextWindowRaw) {
                onSetConfig?.('contextWindow', clamped);
              }
            }
          }}
        />
      )}

      {!hide.has('contextWindow') && isClaudeAgent && contextWindowOptions.length > 1 && (
        <ButtonGroup
          label="Context window"
          options={contextWindowOptions.map((o) => ({ value: String(o.value), label: o.label }))}
          value={String(selectedContextWindow)}
          onSelect={(o) => onSetConfig?.('contextWindow', Number(o.value))}
        />
      )}

      {!hide.has('reasoningEffort') && supportsReasoning && (
        <ButtonGroup
          label="Reasoning effort"
          options={reasoningOptions}
          value={selectedReasoningEffort}
          onSelect={(opt) => onSetConfig?.('reasoningEffort', opt.value)}
        />
      )}

      {!hide.has('permission') && (
        <ButtonGroup
          label="Permission"
          options={permissionOptions}
          value={selectedPermissionMode}
          onSelect={(p) => onSetConfig?.('permissionMode', p.value)}
          layout="grid-2"
        />
      )}

      {/* Sandbox toggle is hidden for codex — its permission preset already
          encodes sandbox_mode (read-only / workspace-write / danger-full-access). */}
      {!hide.has('sandbox') && !isCodexAgent && (
        <ToggleSwitch
          label="Sandbox"
          description="Restrict writes to project directory"
          enabled={sandboxed}
          onChange={(v) => onSetConfig?.('sandboxed', v)}
        />
      )}

      <CodexPendingHint sessionId={sessionId} isCodexAgent={isCodexAgent} />
    </div>
  );
}

// When the user changes model / reasoning effort / permission while a Codex
// turn is in flight, the daemon queues the override for the next turn/start.
// Surface that fact so changes don't look like no-ops.
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
