// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// Module-level shim so chat components can ask the WebSocket client to start
// a fresh round of reconnect attempts after the previous round exhausted its
// budget. `App` registers the socket and peer retry methods on mount; the
// streaming reconnect button can target the session's own machine.
//
// This is intentionally narrow: it only exposes "user-driven retry of a
// dead-link auto-reconnect cycle." It does NOT close a live socket — the
// underlying WebSocketClient.retryReconnect() bails when a reconnect timer
// is already in flight, so calling it during the uncertain-but-still-trying
// window is a no-op rather than an interruption.
let retryFn: ((agentId?: string) => void) | null = null;

export function registerWsRetry(fn: (agentId?: string) => void): void {
  retryFn = fn;
}

export function retryWsReconnect(agentId?: string): void {
  retryFn?.(agentId);
}
