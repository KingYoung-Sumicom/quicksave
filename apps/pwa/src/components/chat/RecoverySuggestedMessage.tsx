// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';

interface Props {
  reason: string;
  action: 'compact';
  label: string;
  onInvoke?: (action: 'compact') => void;
}

const ACTION_PROMPT: Record<Props['action'], string> = {
  compact: '/compact',
};

export function RecoverySuggestedMessage({ reason, action, label, onInvoke }: Props) {
  const [invoked, setInvoked] = useState(false);

  const handleClick = () => {
    if (invoked || !onInvoke) return;
    setInvoked(true);
    onInvoke(action);
  };

  return (
    <div className="mx-auto max-w-prose text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
      <div className="mb-2">{reason}</div>
      <button
        type="button"
        onClick={handleClick}
        disabled={invoked || !onInvoke}
        className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 disabled:bg-amber-500/10 disabled:text-amber-300/60 disabled:cursor-not-allowed px-2.5 py-1 text-xs font-medium text-amber-100 transition-colors"
      >
        {invoked ? `Sent ${ACTION_PROMPT[action]}…` : label}
      </button>
    </div>
  );
}
