// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { FormattedMessage } from 'react-intl';
import { useConnectionStore } from '../stores/connectionStore';
import { retryWsReconnect } from '../lib/wsRetryRegistry';

/**
 * Status for the PWA's own WebSocket to the relay. This is deliberately a
 * compact, non-blocking banner: cached project content can remain useful
 * while the relay reconnects, and an agent-specific screen must not be
 * obscured by an unrelated transport transition.
 */
export function RelayConnectionBanner() {
  const relay = useConnectionStore((s) => s.relay);

  if (relay.state === 'connected') return null;

  const retryable = relay.state === 'disconnected' || relay.state === 'error';
  const tone = retryable
    ? 'bg-red-950/90 border-red-800 text-red-100'
    : 'bg-amber-950/90 border-amber-800 text-amber-100';
  const labelId = retryable
    ? 'relayConnection.disconnected'
    : relay.state === 'reconnecting'
      ? 'relayConnection.reconnecting'
      : 'relayConnection.connecting';

  return (
    <div
      className={`fixed inset-x-0 top-[var(--app-bar-height)] z-[60] border-b px-3 py-2 text-xs shadow-lg ${tone}`}
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-center gap-2">
        <svg className="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <span>
          <FormattedMessage
            id={labelId}
            values={{ attempt: relay.reconnectAttempt ?? 0, maxAttempts: relay.maxReconnectAttempts ?? 0 }}
          />
        </span>
        {relay.error && <span className="hidden max-w-xs truncate opacity-80 sm:inline">{relay.error}</span>}
        {retryable && (
          <button
            type="button"
            onClick={() => retryWsReconnect()}
            className="rounded bg-slate-100/15 px-2 py-0.5 font-medium hover:bg-slate-100/25"
          >
            <FormattedMessage id="relayConnection.retry" />
          </button>
        )}
      </div>
    </div>
  );
}
