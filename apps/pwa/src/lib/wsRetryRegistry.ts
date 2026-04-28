// Module-level shim so chat components can ask the WebSocket client to start
// a fresh round of reconnect attempts after the previous round exhausted its
// budget. `App` registers `client.retryReconnect` on mount; the streaming
// reconnect button reads through this shim.
//
// This is intentionally narrow: it only exposes "user-driven retry of a
// dead-link auto-reconnect cycle." It does NOT close a live socket — the
// underlying WebSocketClient.retryReconnect() bails when a reconnect timer
// is already in flight, so calling it during the uncertain-but-still-trying
// window is a no-op rather than an interruption.
let retryFn: (() => void) | null = null;

export function registerWsRetry(fn: () => void): void {
  retryFn = fn;
}

export function retryWsReconnect(): void {
  retryFn?.();
}
