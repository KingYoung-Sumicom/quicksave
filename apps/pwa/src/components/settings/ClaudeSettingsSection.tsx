import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { MODELS, PERMISSION_MODES } from '../../lib/claudePresets';
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
}

export function ClaudeSettingsSection({ sessionId, onSetConfig }: ClaudeSettingsSectionProps) {
  const config = useSessionConfig(sessionId);

  const selectedModel = (config['model'] as string | undefined) ?? DEFAULT_MODEL;
  const selectedPermissionMode = (config['permissionMode'] as string | undefined) ?? DEFAULT_PERMISSION_MODE;
  const selectedReasoningEffort = (config['reasoningEffort'] as string | undefined) ?? DEFAULT_REASONING_EFFORT;
  const sandboxed = (config['sandboxed'] as boolean | undefined) ?? false;

  const supportsReasoning = selectedModel.startsWith('claude-');

  return (
    <div className="space-y-5">
      <ButtonGroup
        label="Model"
        options={MODELS}
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
        description="Restrict writes to project directory"
        enabled={sandboxed}
        onChange={(v) => onSetConfig?.('sandboxed', v)}
      />
    </div>
  );
}
