import { clsx } from 'clsx';

interface ButtonGroupOption {
  value: string;
  label: string;
  description?: string;
}

interface ButtonGroupProps<T extends ButtonGroupOption> {
  label?: string;
  options: T[];
  value: string;
  onSelect?: (opt: T) => void;
  /** Layout: 'flex' (default) or 'grid-2' for 2-column grid */
  layout?: 'flex' | 'grid-2';
  /** Size variant: 'sm' for new-session panel, 'md' for settings drawer */
  size?: 'sm' | 'md';
  /** Disable all buttons */
  disabled?: boolean;
}

export function ButtonGroup<T extends ButtonGroupOption>({
  label,
  options,
  value,
  onSelect,
  layout = 'flex',
  size = 'md',
  disabled,
}: ButtonGroupProps<T>) {
  const isSmall = size === 'sm';

  return (
    <div>
      {label && (
        <p className={clsx(
          isSmall
            ? 'text-[10px] text-slate-500 uppercase tracking-wide mb-1.5'
            : 'text-sm text-slate-300 mb-1.5',
        )}>{label}</p>
      )}
      <div className={clsx(
        layout === 'grid-2' ? 'grid grid-cols-2 gap-1' : 'flex flex-wrap gap-1',
        isSmall && layout !== 'grid-2' && 'gap-1.5',
      )}>
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={disabled ? undefined : () => onSelect?.(opt)}
            disabled={disabled}
            title={opt.description}
            className={clsx(
              'rounded-md transition-colors',
              isSmall
                ? 'text-xs px-2.5 py-1 rounded-lg border'
                : 'flex-1 text-sm px-3 py-2',
              disabled
                ? value === opt.value
                  ? 'bg-slate-700/40 text-slate-400 border border-slate-600/30 cursor-not-allowed'
                  : 'text-slate-600 cursor-not-allowed'
                : value === opt.value
                  ? isSmall
                    ? 'bg-blue-600/30 border-blue-500/60 text-blue-300'
                    : 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                  : isSmall
                    ? 'bg-slate-700/60 border-slate-600/50 text-slate-400 hover:border-slate-500 hover:text-slate-300'
                    : 'text-slate-300 hover:bg-slate-700',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
