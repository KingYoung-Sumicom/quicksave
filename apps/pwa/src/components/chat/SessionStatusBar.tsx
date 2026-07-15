// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useRef, useEffect, type ReactNode } from 'react';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import type { SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';
import { DEFAULT_CONTEXT_WINDOW } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { getAgentProvider } from '../../lib/agentProvider';
import {
  getCodexFastServiceTierId,
  isCodexFastServiceTier,
  normalizeAgentId,
} from '../../lib/claudePresets';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { CodexGoalBadge } from './CodexGoalBadge';

interface SessionStatusBarProps {
  sessionId: string;
  onSetSessionConfig?: (sessionId: string, key: string, value: ConfigValue) => void;
  onSendControlRequest?: (
    sessionId: string,
    subtype: string,
    params?: Record<string, unknown>,
  ) => Promise<SessionControlRequestResponsePayload>;
  /** Extra chips rendered at the end of the row (e.g. context % / cache countdown). */
  children?: ReactNode;
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

function FastModeBadge({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      title={enabled ? 'Fast mode enabled' : 'Enable Fast mode'}
      onClick={onToggle}
      className={
        enabled
          ? 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-400/40 bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 transition-colors'
          : 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-600 bg-slate-800/70 text-slate-400 hover:border-amber-400/40 hover:text-amber-300 transition-colors'
      }
    >
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
      </svg>
      Fast mode
    </button>
  );
}

export function SessionStatusBar({
  sessionId,
  onSetSessionConfig,
  onSendControlRequest,
  children,
}: SessionStatusBarProps) {
  const config = useSessionConfig(sessionId);
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const codexModels = useConnectionStore((s) => s.codexModels);
  const allow1mForBilledModels = useClaudeStore((s) => s.allow1mForBilledModels);

  const rawAgent = (config.agent as string) ?? 'claude-code';
  const agentId = normalizeAgentId(rawAgent);
  const provider = getAgentProvider(agentId);
  const opencodeModels = useConnectionStore((s) => s.opencodeModels);
  const dynamic = { codexModels, opencodeModels };
  const selectedCodexModel = codexModels.find((model) => model.id === config.model);
  const fastServiceTierId = getCodexFastServiceTierId(selectedCodexModel);
  const fastModeEnabled = isCodexFastServiceTier(selectedCodexModel, config.serviceTier);
  const fastModeAvailable =
    agentId === 'codex' &&
    (fastModeEnabled || fastServiceTierId !== undefined);

  const values: Record<string, unknown> = {
    model: config.model as string | undefined,
    permissionMode: config.permissionMode as string | undefined,
    reasoningEffort: (config.reasoningEffort as string | undefined) ?? 'medium',
    fastMode: fastModeEnabled,
    contextWindow: (config.contextWindow as number | undefined) ?? DEFAULT_CONTEXT_WINDOW,
    sandbox: !!config.sandboxed,
  };

  const onChange = (key: string, value: unknown) => {
    const wireKey = key === 'sandbox' ? 'sandboxed' : key === 'fastMode' ? 'serviceTier' : key;
    const wireValue = key === 'fastMode' ? (value ? fastServiceTierId ?? 'fast' : null) : value;
    onSetSessionConfig?.(sessionId, wireKey, wireValue as ConfigValue);
    setOpenPopover(null);
  };

  const agentLabel = AGENT_LABEL[agentId] ?? AGENT_LABEL['claude-code'];

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

  return (
    <div ref={barRef} className="relative flex items-center gap-1.5 pb-2 text-xs flex-wrap">
      <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-700/60 text-slate-400">
        {agentLabel}
      </span>

      {provider.renderStatusChips(values, onChange, {
        dynamic,
        openPopover,
        onOpenPopover: setOpenPopover,
        allow1mForBilledModels,
      })}

      {fastModeAvailable && (
        <FastModeBadge
          enabled={values.fastMode === true}
          onToggle={() => onChange('fastMode', values.fastMode !== true)}
        />
      )}

      <CodexGoalBadge sessionId={sessionId} onSendControlRequest={onSendControlRequest} />

      {children}
    </div>
  );
}
