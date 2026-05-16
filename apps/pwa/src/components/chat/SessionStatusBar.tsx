// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useRef, useEffect, type ReactNode } from 'react';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_CONTEXT_WINDOW } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { getAgentProvider } from '../../lib/agentProvider';
import { normalizeAgentId } from '../../lib/claudePresets';
import { useConnectionStore } from '../../stores/connectionStore';

interface SessionStatusBarProps {
  sessionId: string;
  onSetSessionConfig?: (sessionId: string, key: string, value: ConfigValue) => void;
  /** Extra chips rendered at the end of the row (e.g. context % / cache countdown). */
  children?: ReactNode;
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function SessionStatusBar({ sessionId, onSetSessionConfig, children }: SessionStatusBarProps) {
  const config = useSessionConfig(sessionId);
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const codexModels = useConnectionStore((s) => s.codexModels);

  const rawAgent = (config.agent as string) ?? 'claude-code';
  const agentId = normalizeAgentId(rawAgent);
  const provider = getAgentProvider(agentId);
  const opencodeModels = useConnectionStore((s) => s.opencodeModels);
  const dynamic = { codexModels, opencodeModels };

  const values: Record<string, unknown> = {
    model: config.model as string | undefined,
    permissionMode: config.permissionMode as string | undefined,
    reasoningEffort: (config.reasoningEffort as string | undefined) ?? 'medium',
    contextWindow: (config.contextWindow as number | undefined) ?? DEFAULT_CONTEXT_WINDOW,
    sandbox: !!config.sandboxed,
  };

  const onChange = (key: string, value: unknown) => {
    const wireKey = key === 'sandbox' ? 'sandboxed' : key;
    onSetSessionConfig?.(sessionId, wireKey, value as ConfigValue);
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
      })}

      {children}
    </div>
  );
}
