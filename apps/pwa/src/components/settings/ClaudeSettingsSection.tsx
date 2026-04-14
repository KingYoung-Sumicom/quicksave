import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_AGENT, DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { useConnectionStore } from '../../stores/connectionStore';
import { AGENT_TYPES, PERMISSION_MODES, getModelsForAgent } from '../../lib/claudePresets';
import { ButtonGroup } from '../ui/ButtonGroup';
import { ToggleSwitch } from '../ui/ToggleSwitch';

const REASONING_EFFORT_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Minimal thinking, fastest responses' },
  { value: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { value: 'high', label: 'High', description: 'Deep thinking' },
  { value: 'max', label: 'Max', description: 'Maximum effort (Opus only)' },
];

interface ClaudeSettingsSectionProps {
  /** Session ID — null means new session (shows defaults, changes update store only) */
  sessionId: string | null;
  /** Called for any config key change on an active session */
  onSetConfig?: (key: string, value: ConfigValue) => void;
  /** When true, the agent selector is read-only (e.g. active session) */
  agentLocked?: boolean;
}

export function ClaudeSettingsSection({ sessionId, onSetConfig, agentLocked }: ClaudeSettingsSectionProps) {
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
  const models = getModelsForAgent(selectedAgent, codexModels);
  const supportsReasoning = isClaudeAgent
    ? selectedModel.startsWith('claude-')
    : selectedAgent === 'codex';

  return (
    <div className="space-y-5">
        <ButtonGroup
        label="Agent"
        options={AGENT_TYPES}
        value={selectedAgent}
        onSelect={agentLocked ? undefined : (agent) => onSetConfig?.('agent', agent.value)}
        disabled={agentLocked}
      />

      <ButtonGroup
        label="Model"
        options={models}
        value={selectedModel}
        onSelect={(m) => onSetConfig?.('model', m.value)}
      />

      {supportsReasoning && (
        <ButtonGroup
          label="Reasoning effort"
          options={REASONING_EFFORT_OPTIONS}
          value={selectedReasoningEffort}
          onSelect={(opt) => onSetConfig?.('reasoningEffort', opt.value)}
        />
      )}

      <ButtonGroup
        label="Permission"
        options={PERMISSION_MODES}
        value={selectedPermissionMode}
        onSelect={(p) => onSetConfig?.('permissionMode', p.value)}
        layout="grid-2"
      />

      <ToggleSwitch
        label="Sandbox"
        description={selectedAgent === 'codex' ? 'Workspace-write sandbox for Codex' : 'Restrict writes to project directory'}
        enabled={sandboxed}
        onChange={(v) => onSetConfig?.('sandboxed', v)}
      />
    </div>
  );
}
