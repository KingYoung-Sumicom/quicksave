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
let agentBusGetter: ((agentId: string) => MessageBusClient | null) | null = null;

export function registerActiveBusGetter(getter: () => MessageBusClient | null): void {
  activeBusGetter = getter;
}

export function registerAgentBusGetter(getter: (agentId: string) => MessageBusClient | null): void {
  agentBusGetter = getter;
}

export function getActiveBus(): MessageBusClient | null {
  return activeBusGetter ? activeBusGetter() : null;
}

/**
 * Look up a specific agent's bus by ID. Use this for ops bound to a
 * resource that lives on a known agent (e.g. a terminal whose owner is
 * encoded in the URL projectId) — `getActiveBus()` is wrong for those
 * because the user might have switched to a different agent since the
 * resource was created.
 */
export function getBusForAgent(agentId: string): MessageBusClient | null {
  return agentBusGetter ? agentBusGetter(agentId) : null;
}
