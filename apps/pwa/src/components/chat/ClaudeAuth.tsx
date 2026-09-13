// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { useClaudeAuth } from '../../hooks/useClaudeAuth';

export function ClaudeAuthBanner({ agentId }: { agentId?: string | null }) {
  const { authState, refreshStatus } = useClaudeAuth(agentId);
  const [checking, setChecking] = useState(false);

  if (!authState || authState.loggedIn) return null;
  const unavailable = Boolean(authState.error);

  const refresh = async () => {
    setChecking(true);
    try {
      await refreshStatus();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 flex items-start gap-2">
      <svg className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="font-medium text-amber-100">
          <FormattedMessage
            id={authState.error === 'claude-cli-not-found'
              ? 'claudeAuth.banner.cliMissingTitle'
              : authState.error === 'auth-status-unavailable'
                ? 'claudeAuth.banner.unavailableTitle'
                : 'claudeAuth.banner.title'}
          />
        </p>
        <p className="text-amber-200/80">
          <FormattedMessage
            id={authState.error === 'claude-cli-not-found'
              ? 'claudeAuth.banner.cliMissing'
              : authState.error === 'auth-status-unavailable'
                ? 'claudeAuth.banner.unavailable'
                : 'claudeAuth.banner.body'}
          />
        </p>
        {!unavailable && (
          <code className="block w-fit rounded bg-slate-950/60 px-2 py-1 text-amber-100">
            claude auth login
          </code>
        )}
        <button
          type="button"
          onClick={() => { void refresh(); }}
          disabled={checking}
          className="mt-1 inline-flex items-center rounded-md bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-60 border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-50 transition-colors"
        >
          <FormattedMessage id={checking ? 'claudeAuth.banner.checking' : 'claudeAuth.banner.refresh'} />
        </button>
      </div>
    </div>
  );
}
