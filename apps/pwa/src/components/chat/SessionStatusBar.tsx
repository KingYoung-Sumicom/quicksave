import { useState, useRef, useEffect, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useIntl } from 'react-intl';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { getModelsForAgent, getPermissionModesForAgent, getReasoningEffortsForModel } from '../../lib/claudePresets';
import { useConnectionStore } from '../../stores/connectionStore';

interface SessionStatusBarProps {
  sessionId: string;
  onSetSessionConfig?: (sessionId: string, key: string, value: ConfigValue) => void;
  /** Extra chips rendered at the end of the row (e.g. context % / cache countdown). */
  children?: ReactNode;
}

type PopoverType = 'model' | 'permission' | 'effort' | null;

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
};

export function SessionStatusBar({ sessionId, onSetSessionConfig, children }: SessionStatusBarProps) {
  const intl = useIntl();
  const config = useSessionConfig(sessionId);
  const [openPopover, setOpenPopover] = useState<PopoverType>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const agent = (config.agent as string) ?? 'claude-code';
  const codexModels = useConnectionStore((s) => s.codexModels);
  const agentId = agent as 'claude-code' | 'codex';
  const models = getModelsForAgent(agentId, codexModels);

  const currentModel = config.model as string | undefined;
  const currentPermission = config.permissionMode as string | undefined;
  const currentEffort = (config.reasoningEffort as string | undefined) ?? 'medium';
  const sandboxed = !!config.sandboxed;

  // Agent-specific dropdowns: codex picker exposes its own ApprovalMode union
  // and per-model reasoning levels rather than reusing Claude's labels.
  const permissionModes = getPermissionModesForAgent(agentId);
  const reasoningEfforts = getReasoningEffortsForModel(agentId, currentModel, codexModels);

  const modelLabel = models.find((m) => m.value === currentModel)?.label ?? currentModel ?? 'Unknown';
  const permissionLabel = permissionModes.find((p) => p.value === currentPermission)?.label ?? currentPermission ?? 'Default';
  const effortLabel = reasoningEfforts.find((e) => e.value === currentEffort)?.label ?? currentEffort;

  const agentLabel = AGENT_LABEL[agent] ?? AGENT_LABEL['claude-code'];

  const supportsReasoning = agent === 'codex' || (currentModel ?? '').startsWith('claude-');

  // Close popover on outside click
  useEffect(() => {
    if (!openPopover) return;
    const handler = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenPopover(null);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [openPopover]);

  const handleSelectModel = (value: string) => {
    onSetSessionConfig?.(sessionId, 'model', value);
    setOpenPopover(null);
  };

  const handleSelectPermission = (value: string) => {
    onSetSessionConfig?.(sessionId, 'permissionMode', value);
    setOpenPopover(null);
  };

  const handleSelectEffort = (value: string) => {
    onSetSessionConfig?.(sessionId, 'reasoningEffort', value);
    setOpenPopover(null);
  };

  const handleToggleSandbox = () => {
    onSetSessionConfig?.(sessionId, 'sandboxed', !sandboxed);
  };

  return (
    <div ref={barRef} className="relative flex items-center gap-1.5 pb-2 text-xs flex-wrap">
      {/* Agent badge — same style as chips but non-interactive */}
      <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-700/60 text-slate-400">
        {agentLabel}
      </span>

      {/* Model chip */}
      <button
        type="button"
        onClick={() => setOpenPopover(openPopover === 'model' ? null : 'model')}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors',
          openPopover === 'model'
            ? 'bg-blue-600/20 text-blue-400'
            : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
        )}
      >
        {modelLabel}
        <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Permission chip */}
      <button
        type="button"
        onClick={() => setOpenPopover(openPopover === 'permission' ? null : 'permission')}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors',
          openPopover === 'permission'
            ? 'bg-blue-600/20 text-blue-400'
            : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
        )}
      >
        {/* Shield icon */}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        {permissionLabel}
        <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Reasoning effort chip */}
      {supportsReasoning && (
        <button
          type="button"
          onClick={() => setOpenPopover(openPopover === 'effort' ? null : 'effort')}
          className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded-md transition-colors',
            openPopover === 'effort'
              ? 'bg-blue-600/20 text-blue-400'
              : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
          )}
        >
          {/* Brain/bolt icon */}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {effortLabel}
          <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}

      {/* Sandbox toggle chip — hidden for codex because the permission preset
          already bundles sandbox_mode (read-only / workspace-write /
          danger-full-access). Showing both axes would let the user pick
          contradictory settings. */}
      {agentId !== 'codex' && (
        <button
          type="button"
          onClick={handleToggleSandbox}
          className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded-md transition-colors',
            sandboxed
              ? 'bg-emerald-600/20 text-emerald-400'
              : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
          )}
          title={intl.formatMessage({ id: sandboxed ? 'sessionStatus.sandbox.titleOn' : 'sessionStatus.sandbox.titleOff' })}
        >
          {/* Box icon */}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          Sandbox
        </button>
      )}

      {children}

      {/* Popover — Model */}
      {openPopover === 'model' && (
        <div className="absolute bottom-full left-0 mb-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[180px] z-50">
          {models.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => handleSelectModel(m.value)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors',
                m.value === currentModel
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-300 hover:bg-slate-700'
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* Popover — Permission */}
      {openPopover === 'permission' && (
        <div className="absolute bottom-full left-0 mb-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[180px] z-50">
          {permissionModes.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => handleSelectPermission(p.value)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors',
                p.value === currentPermission
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-300 hover:bg-slate-700'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Popover — Reasoning effort */}
      {openPopover === 'effort' && (
        <div className="absolute bottom-full left-0 mb-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[180px] z-50">
          {reasoningEfforts.map((e) => (
            <button
              key={e.value}
              type="button"
              onClick={() => handleSelectEffort(e.value)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors',
                e.value === currentEffort
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-300 hover:bg-slate-700'
              )}
            >
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
