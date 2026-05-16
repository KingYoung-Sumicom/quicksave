// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

/**
 * Module-level registry so components can reach a specific agent's bus by ID
 * without prop-drilling through every parent.
 *
 * Always use `getBusForAgent(agentId)` with an explicit agent ID — never rely
 * on an implicit "active" agent. The agentId is always available from the URL
 * projectId, the session's machineAgentId, or the attachment's agentId field.
 */
let agentBusGetter: ((agentId: string) => MessageBusClient | null) | null = null;

export function registerAgentBusGetter(getter: (agentId: string) => MessageBusClient | null): void {
  agentBusGetter = getter;
}

export function getBusForAgent(agentId: string): MessageBusClient | null {
  return agentBusGetter ? agentBusGetter(agentId) : null;
}
