// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { clsx } from 'clsx';

interface ToggleSwitchProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label?: string;
  description?: string;
  /** Compact variant for inline use (smaller label). Default: false */
  compact?: boolean;
}

export function ToggleSwitch({ enabled, onChange, label, description, compact }: ToggleSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      {label && (
        <div className={compact ? undefined : 'flex-1'}>
          <span className={clsx(
            compact ? 'text-xs font-medium text-slate-400' : 'text-sm text-slate-300',
          )}>{label}</span>
          {description && <p className="text-xs text-slate-500">{description}</p>}
        </div>
      )}
      <button
        onClick={() => onChange(!enabled)}
        className={clsx(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0',
          enabled ? 'bg-blue-600' : 'bg-slate-600',
        )}
      >
        <span
          className={clsx(
            'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
            enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
