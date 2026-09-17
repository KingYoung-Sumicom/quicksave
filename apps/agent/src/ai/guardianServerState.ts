// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Daemon-wide reachability state for the guardian reviewer model server.
//
// `auto-review` depends on a user-configured, OpenAI-compatible model server;
// a dead or misconfigured server would otherwise only surface as repeated
// fail-closed denials deep inside a session. The daemon tracks the latest
// known health here so the settings UI (and the PWA) can show the server as
// unreachable before the user has to watch reviews fail one by one.
//
// The state is process-local by design: it resets when the daemon (re)starts
// and is invalidated whenever the stored settings change, because a new
// base URL/model may point at a completely different server.

export type GuardianServerStatus = 'unknown' | 'ok' | 'failed';

export interface GuardianServerState {
  status: GuardianServerStatus;
  /** Epoch ms of the last review/probe that produced this state. */
  lastCheckedAt?: number;
  /** Last failure reason (HTTP status, transport error, timeout, ...). */
  lastError?: string;
}

let state: GuardianServerState = { status: 'unknown' };

export function getGuardianServerState(): GuardianServerState {
  return { ...state };
}

/** Clear recorded health (settings changed, daemon restart, ...). */
export function resetGuardianServerState(): void {
  state = { status: 'unknown' };
}

export function recordGuardianServerResult(ok: boolean, error?: string): void {
  state = ok
    ? { status: 'ok', lastCheckedAt: Date.now() }
    : { status: 'failed', lastCheckedAt: Date.now(), ...(error ? { lastError: error } : {}) };
}
