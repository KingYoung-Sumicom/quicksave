// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useMemo } from 'react';
import { clsx } from 'clsx';

interface ButtonGroupOption {
  value: string;
  label: string;
  description?: string;
  providerId?: string;
  providerName?: string;
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
  /** When set, enables two-level provider+model mode. */
  providerLabel?: string;
  modelLabel?: string;
  /** Ordered list of provider ids sorted by last chosen (most recent first). */
  lastChosenProviders?: string[];
  /** Called when a provider is selected (for tracking lastChosenProviders). */
  onProviderSelect?: (providerId: string) => void;
}

function groupByProvider<T extends ButtonGroupOption>(options: T[]): T[][] {
  const groups: Map<string, T[]> = new Map();
  const ordered: string[] = [];
  for (const opt of options) {
    if (!opt.providerId) continue;
    if (!groups.has(opt.providerId)) {
      groups.set(opt.providerId, []);
      ordered.push(opt.providerId);
    }
    groups.get(opt.providerId)!.push(opt);
  }
  return ordered.map((id) => groups.get(id)!);
}

function sortProviders<T extends ButtonGroupOption>(
  groups: T[][],
  lastChosenProviders: string[],
): T[][] {
  // Known built-in providers that come from opencode's registry, not user config.
  // When there's no tracking data, user-configured providers (e.g. vLLM) should
  // appear above these generic ones.
  const BUILTIN_PROVIDERS = new Set([
    'openai', 'anthropic', 'google', 'groq', 'mistral', 'cohere',
    'deepinfra', 'fireworks', 'perplexity', 'together', 'openrouter',
    'cerebras', 'nvidia', 'huggingface', 'voyage', 'replicate',
    'opencode',
  ]);

  if (lastChosenProviders.length === 0) {
    // No tracking data — user-configured providers first, then built-in alphabetically
    return [...groups].sort((a, b) => {
      const aIsBuiltin = BUILTIN_PROVIDERS.has(a[0]?.providerId ?? '');
      const bIsBuiltin = BUILTIN_PROVIDERS.has(b[0]?.providerId ?? '');
      if (aIsBuiltin && !bIsBuiltin) return 1;
      if (!aIsBuiltin && bIsBuiltin) return -1;
      return (a[0]?.providerName ?? '').localeCompare(b[0]?.providerName ?? '');
    });
  }

  const index = new Map<string, number>();
  lastChosenProviders.forEach((id, i) => index.set(id, i));
  return [...groups].sort((a, b) => {
    const aIdx = index.get(a[0]?.providerId ?? '');
    const bIdx = index.get(b[0]?.providerId ?? '');
    const aHas = aIdx !== undefined;
    const bHas = bIdx !== undefined;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    if (aHas && bHas) return aIdx - bIdx;
    return (a[0]?.providerName ?? '').localeCompare(b[0]?.providerName ?? '');
  });
}

function OptionButton<T extends ButtonGroupOption>({
  opt,
  selected,
  size,
  onClick,
  disabled,
}: {
  opt: T;
  selected: boolean;
  size: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={opt.description}
      className={clsx(
        'rounded-md focus:outline-none',
        size
          ? 'text-xs px-2.5 py-1 rounded-lg border'
          : 'flex-1 text-sm px-3 py-2',
        disabled
          ? selected
            ? 'bg-slate-700/40 text-slate-400 border border-slate-600/30 cursor-not-allowed'
            : 'text-slate-600 cursor-not-allowed'
          : selected
            ? size
              ? 'bg-blue-600/30 border-blue-500/60 text-blue-300'
              : 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
            : size
              ? 'bg-slate-700/60 border-slate-600/50 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
              : 'text-slate-300 hover:bg-slate-700',
      )}
    >
      {opt.label}
    </button>
  );
}

function ProviderDropdown<T extends ButtonGroupOption>({
  groups,
  selectedProviderId,
  onSelect,
  size,
  lastChosenProviders,
}: {
  groups: T[][];
  selectedProviderId: string;
  onSelect: (providerId: string) => void;
  size: boolean;
  lastChosenProviders: string[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const sortedGroups = useMemo(
    () => sortProviders(groups, lastChosenProviders),
    [groups, lastChosenProviders],
  );

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return sortedGroups;
    const q = search.toLowerCase();
    return sortedGroups.filter((g) => {
      const name = (g[0]?.providerName ?? '').toLowerCase();
      return name.includes(q);
    });
  }, [sortedGroups, search]);

  const selectedGroup = groups.find((g) => g[0]?.providerId === selectedProviderId);
  const selectedName = selectedGroup?.[0]?.providerName ?? '';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={clsx(
          'w-full flex items-center justify-between gap-1 rounded-md focus:outline-none transition-colors text-left',
          size
            ? 'text-xs px-2.5 py-1 border bg-slate-700/60 text-slate-300 hover:bg-slate-700'
            : 'text-sm px-3 py-2 border border-slate-600/50 bg-slate-700/60 text-slate-300 hover:bg-slate-700',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{selectedName}</span>
        <svg
          className={clsx('w-3 h-3 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 overflow-hidden">
            <div className="p-1.5 border-b border-slate-700">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search providers..."
                className="w-full bg-slate-900 border border-slate-600 rounded-md px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>
            <ul role="listbox" className="max-h-[20rem] overflow-y-auto py-1">
              {filteredGroups.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-500 text-center">No providers found</li>
              ) : (
                filteredGroups.map((group) => {
                  const providerId = group[0]?.providerId ?? '';
                  const providerName = group[0]?.providerName ?? '';
                  const isSelected = providerId === selectedProviderId;
                  return (
                    <li key={providerId} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(providerId);
                          setOpen(false);
                          setSearch('');
                        }}
                        className={clsx(
                          'w-full text-left px-3 py-1.5 text-xs transition-colors',
                          isSelected
                            ? 'bg-blue-600/20 text-blue-400'
                            : 'text-slate-300 hover:bg-slate-700',
                        )}
                      >
                        {providerName}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

export function ButtonGroup<T extends ButtonGroupOption>({
  label,
  options,
  value,
  onSelect,
  layout = 'flex',
  size = 'md',
  disabled,
  providerLabel,
  modelLabel,
  lastChosenProviders,
  onProviderSelect,
}: ButtonGroupProps<T>) {
  const isSmall = size === 'sm';
  const groups = groupByProvider(options);
  const flatOptions = groups.length === 0 ? options : groups.flat();
  const hasGroups = groups.length > 0;

  // Two-level mode: provider dropdown + model buttons
  if (hasGroups) {
    const sortedGroups = sortProviders(groups, lastChosenProviders ?? []);
    const [selectedProvider, setSelectedProvider] = useState<string>(
      sortedGroups[0]?.[0]?.providerId ?? '',
    );

    const selectedProviderGroup = sortedGroups.find((g) => g[0]?.providerId === selectedProvider) ?? sortedGroups[0];
    const selectedProviderName = selectedProviderGroup?.[0]?.providerName ?? '';

    return (
      <div className="space-y-2">
        {/* First level: provider dropdown */}
        <div>
          <p className={clsx(
            isSmall
              ? 'text-[10px] text-slate-500 uppercase tracking-wide mb-1.5'
              : 'text-sm text-slate-300 mb-1.5',
          )}>{providerLabel ?? 'Model Provider'}</p>
          <ProviderDropdown
            groups={sortedGroups}
            selectedProviderId={selectedProvider}
            onSelect={(providerId) => {
              setSelectedProvider(providerId);
              onProviderSelect?.(providerId);
              // Auto-select the previously selected model in this group, or first model
              const group = sortedGroups.find((g) => g[0]?.providerId === providerId);
              const currentInGroup = group?.find((o) => o.value === value);
              const firstInGroup = group?.[0];
              if (currentInGroup || firstInGroup) {
                onSelect?.(currentInGroup ?? firstInGroup!);
              }
            }}
            size={isSmall}
            lastChosenProviders={lastChosenProviders ?? []}
          />
        </div>
        {/* Second level: model buttons for selected provider */}
        <div>
          <p className={clsx(
            isSmall
              ? 'text-[10px] text-slate-500 uppercase tracking-wide mb-1.5'
              : 'text-xs text-slate-400 mb-1.5',
          )}>{modelLabel ?? selectedProviderName}</p>
          <div className={clsx(
            layout === 'grid-2' ? 'grid grid-cols-2 gap-1' : 'flex flex-wrap gap-1',
            isSmall && layout !== 'grid-2' && 'gap-1.5',
          )}>
            {selectedProviderGroup.map((opt) => (
              <OptionButton
                key={opt.value}
                opt={opt}
                selected={opt.value === value}
                size={isSmall}
                onClick={() => onSelect?.(opt)}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Single-level mode (no provider grouping)
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
        {flatOptions.map((opt) => (
          <OptionButton
            key={opt.value}
            opt={opt}
            selected={opt.value === value}
            size={isSmall}
            onClick={() => onSelect?.(opt)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}
