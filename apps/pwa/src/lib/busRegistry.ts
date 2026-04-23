import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

/**
 * Module-level indirection so deep components can dispatch bus commands
 * without prop-drilling `getBus` through every parent. `App` registers its
 * `getActiveBus` closure on mount; hooks like `useCodexLogin` read through
 * this shim.
 *
 * This is intentionally narrow in scope: only use it for one-shot command
 * dispatch where no stable subscription handle is needed. For subscriptions
 * (which must be torn down on unmount) continue to pass `getBus` explicitly.
 */
let activeBusGetter: (() => MessageBusClient | null) | null = null;

export function registerActiveBusGetter(getter: () => MessageBusClient | null): void {
  activeBusGetter = getter;
}

export function getActiveBus(): MessageBusClient | null {
  return activeBusGetter ? activeBusGetter() : null;
}
