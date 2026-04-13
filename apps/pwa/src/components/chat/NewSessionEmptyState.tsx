import { useClaudeStore } from '../../stores/claudeStore';
import { MODELS, PERMISSION_MODES, AGENT_TYPES, type AgentType } from '../../lib/claudePresets';
import { ButtonGroup } from '../ui/ButtonGroup';
import { ToggleSwitch } from '../ui/ToggleSwitch';

const REASONING_EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export function NewSessionEmptyState({ cwd, selectedAgentType, onSelectAgentType }: {
  cwd?: string;
  selectedAgentType: AgentType;
  onSelectAgentType: (agent: AgentType) => void;
}) {
  const { selectedModel, selectedPermissionMode, selectedReasoningEffort, sandboxEnabled, setSelectedModel, setSelectedPermissionMode, setSelectedReasoningEffort, setSandboxEnabled } = useClaudeStore();

  return (
    <div className="px-4 pt-4 pb-2 flex justify-start">
      <div className="bg-slate-800/50 rounded-xl p-4 space-y-4 border border-slate-700/50 inline-block min-w-0">
        {/* Title + path */}
        <div>
          <h2 className="text-sm font-semibold text-slate-200">New Session</h2>
          {cwd && (
            <p className="mt-0.5 text-xs text-slate-500 flex items-center gap-1 min-w-0">
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
              <span className="truncate">{cwd}</span>
            </p>
          )}
        </div>

        {/* Selectors */}
        <ButtonGroup label="Agent" options={AGENT_TYPES} value={selectedAgentType.value} onSelect={onSelectAgentType} size="sm" />
        <ButtonGroup label="Model" options={MODELS} value={selectedModel} onSelect={(m) => setSelectedModel(m.value)} size="sm" />
        <ButtonGroup label="Reasoning Effort" options={REASONING_EFFORTS} value={selectedReasoningEffort} onSelect={(e) => setSelectedReasoningEffort(e.value as 'low' | 'medium' | 'high' | 'max')} size="sm" />
        <ButtonGroup label="Permission" options={PERMISSION_MODES} value={selectedPermissionMode} onSelect={(p) => setSelectedPermissionMode(p.value)} size="sm" />
        <ToggleSwitch label="Sandbox" enabled={sandboxEnabled} onChange={setSandboxEnabled} compact />

        {/* Hint */}
        <p className="text-xs text-slate-600">
          Type a message below to start the session
        </p>
      </div>
    </div>
  );
}
