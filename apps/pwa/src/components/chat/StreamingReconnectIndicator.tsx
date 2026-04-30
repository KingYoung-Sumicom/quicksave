// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useConnectionStore } from '../../stores/connectionStore';
import { retryWsReconnect } from '../../lib/wsRetryRegistry';

/**
 * Replaces the streaming bounce-dots while the connection is in an uncertain
 * or terminal state. Three modes:
 *
 *   - **In flight** (`connecting` / `reconnecting`, or relay reports the
 *     agent peer is offline): spinner only. We don't know yet whether the
 *     stream is alive or dead, so just animate; no user action needed.
 *   - **Gave up** (`disconnected` / `error`): spinner + a "重新連線" button
 *     that kicks off a fresh round of auto-reconnect attempts. This is the
 *     only path that takes a deliberate user click — we never preemptively
 *     close a healthy socket from the UI.
 *   - **Connected and agent online**: render nothing; caller (ClaudePanel)
 *     falls back to the regular bounce-dots indicator.
 */
export function StreamingReconnectIndicator() {
  const state = useConnectionStore((s) => s.state);
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt);
  const maxReconnectAttempts = useConnectionStore((s) => s.maxReconnectAttempts);
  const agentOnline = useConnectionStore((s) => s.agentOnline);

  const inFlight = state === 'reconnecting' || state === 'connecting' || (state === 'connected' && agentOnline === false);
  const gaveUp = state === 'disconnected' || state === 'error';

  if (!inFlight && !gaveUp) return null;

  const label = state === 'reconnecting' && reconnectAttempt
    ? `重新連線中… (${reconnectAttempt}/${maxReconnectAttempts ?? '?'})`
    : state === 'connecting'
    ? '連線中…'
    : state === 'connected' && agentOnline === false
    ? '等待 agent 回應…'
    : '連線中斷';

  return (
    <div className="flex items-center gap-2 py-1 text-xs text-slate-400">
      <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      <span>{label}</span>
      {gaveUp && (
        <button
          type="button"
          onClick={() => retryWsReconnect()}
          className="ml-1 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs"
        >
          重新連線
        </button>
      )}
    </div>
  );
}
