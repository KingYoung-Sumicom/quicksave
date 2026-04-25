import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_AGENT, DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { useConnectionStore } from '../../stores/connectionStore';
import {
  AGENT_TYPES,
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
  hideFields?: Array<'agent' | 'model' | 'permission' | 'reasoningEffort' | 'sandbox'>;
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

  const isClaudeAgent = selectedAgent === 'claude-code';
  const isCodexAgent = selectedAgent === 'codex';
  const models = getModelsForAgent(selectedAgent, codexModels);
  const supportsReasoning = isClaudeAgent
    ? selectedModel.startsWith('claude-')
    : isCodexAgent;
  const reasoningOptions = getReasoningEffortsForModel(selectedAgent, selectedModel, codexModels);
  const permissionOptions = getPermissionModesForAgent(selectedAgent);

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
          onSelect={(m) => onSetConfig?.('model', m.value)}
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
    </div>
  );
}
