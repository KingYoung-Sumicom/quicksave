// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from 'react';
import { ChevronIcon } from '../../ui/ChevronIcon';

const LONG_COMMAND_THRESHOLD = 100;

export function BashToolView({ input, headerSuffix, isPending }: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
  isPending?: boolean;
}) {
  const command = (input.command as string) || '?';
  const description = input.description as string | undefined;

  const collapsible = !isPending && command.length > LONG_COMMAND_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const showCollapsed = collapsible && !expanded;

  return (
    <div>
      {description && (
        <div className="text-slate-200 text-sm mb-1">{description}</div>
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-orange-400 shrink-0">$</span>{' '}
        <span
          className={`font-mono text-slate-400 flex-1 min-w-0 ${showCollapsed ? 'truncate' : 'break-all'}`}
        >
          {command}
        </span>
        {collapsible && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded px-1 py-0.5 transition-colors"
            aria-label={expanded ? 'Collapse command' : 'Expand command'}
          >
            <ChevronIcon expanded={expanded} size="w-2.5 h-2.5" strokeWidth={2.5} />
          </button>
        )}
        {headerSuffix}
      </div>
    </div>
  );
}
