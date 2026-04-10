import { clsx } from 'clsx';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { MODELS, PERMISSION_MODES } from '../../lib/claudePresets';

const REASONING_EFFORT_OPTIONS: { value: 'low' | 'medium' | 'high' | 'max'; label: string; description: string }[] = [
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

  const supportsReasoning = selectedModel.startsWith('claude-');

  return (
    <div className="space-y-5">
      {/* Model */}
      <div className="space-y-1.5">
        <p className="text-sm text-slate-300">Model</p>
        <div className="flex gap-1">
          {MODELS.map((m) => (
            <button
              key={m.value}
              onClick={() => onSetConfig?.('model', m.value)}
              className={clsx(
                'flex-1 text-sm px-3 py-2 rounded-md transition-colors',
                selectedModel === m.value
                  ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-700'
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Reasoning effort — Claude only */}
      {supportsReasoning && (
        <div className="space-y-1.5">
          <p className="text-sm text-slate-300">Reasoning effort</p>
          <div className="flex gap-1">
            {REASONING_EFFORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onSetConfig?.('reasoningEffort', opt.value)}
                title={opt.description}
                className={clsx(
                  'flex-1 text-sm px-3 py-2 rounded-md transition-colors',
                  selectedReasoningEffort === opt.value
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                    : 'text-slate-300 hover:bg-slate-700'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Permission Mode */}
      <div className="space-y-1.5">
        <p className="text-sm text-slate-300">Permission</p>
        <div className="grid grid-cols-2 gap-1">
          {PERMISSION_MODES.map((p) => (
            <button
              key={p.value}
              onClick={() => onSetConfig?.('permissionMode', p.value)}
              className={clsx(
                'text-sm px-3 py-2 rounded-md transition-colors',
                selectedPermissionMode === p.value
                  ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-700'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
