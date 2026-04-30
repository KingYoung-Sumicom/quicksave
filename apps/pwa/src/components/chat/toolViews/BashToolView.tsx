// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

export function BashToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const command = (input.command as string) || '?';
  const description = input.description as string | undefined;

  return (
    <div>
      {description && (
        <div className="text-slate-200 text-sm mb-1">{description}</div>
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-orange-400 shrink-0">$</span>{' '}
        <span className="font-mono break-all text-slate-400 flex-1 min-w-0">{command}</span>
        {headerSuffix}
      </div>
    </div>
  );
}
