import { useCallback } from 'react';
import type {
  CodexListModelsResponsePayload,
  CodexLoginCancelResponsePayload,
  CodexLoginStartResponsePayload,
  CodexLoginState,
  CodexLoginStatusResponsePayload,
  CodexModelInfo,
} from '@sumicom/quicksave-shared';
import { useCodexLoginStore } from '../stores/codexLoginStore';
import { useConnectionStore } from '../stores/connectionStore';
import { getActiveBus } from '../lib/busRegistry';

/**
 * Hook for driving the Codex OAuth device-auth flow.
 *
 * Login state itself (logged in? in progress? current code) is streamed via
 * the `/codex/login` bus subscription into {@link useCodexLoginStore}. This
 * hook only provides the command verbs — start, status-refresh, cancel —
 * and a post-login model refresh that re-hydrates the model picker once
 * credentials appear.
 */
export function useCodexLogin() {
  const agentId = useConnectionStore((s) => s.agentId);
  const loginState = useCodexLoginStore((s) => (agentId ? s.byAgent[agentId] : undefined));

  const start = useCallback(async (): Promise<CodexLoginState | null> => {
    const bus = getActiveBus();
    if (!bus) return null;
    const res = await bus.command<CodexLoginStartResponsePayload>(
      'codex:login-start',
      {},
      { timeoutMs: 60_000, queueWhileDisconnected: false },
    );
    return res;
  }, []);

  const refreshStatus = useCallback(async (): Promise<CodexLoginState | null> => {
    const bus = getActiveBus();
    if (!bus) return null;
    return bus.command<CodexLoginStatusResponsePayload>(
      'codex:login-status',
      {},
      { timeoutMs: 10_000, queueWhileDisconnected: false },
    );
  }, []);

  const cancel = useCallback(async (): Promise<boolean> => {
    const bus = getActiveBus();
    if (!bus) return false;
    const res = await bus.command<CodexLoginCancelResponsePayload>(
      'codex:login-cancel',
      {},
      { timeoutMs: 5_000, queueWhileDisconnected: false },
    );
    return Boolean(res.ok);
  }, []);

  const refreshModels = useCallback(async (): Promise<CodexModelInfo[] | null> => {
    const bus = getActiveBus();
    if (!bus) return null;
    const res = await bus.command<CodexListModelsResponsePayload>(
      'codex:list-models',
      {},
      { timeoutMs: 15_000, queueWhileDisconnected: false },
    );
    if (res.models.length > 0) {
      useConnectionStore.getState().setCodexModels(res.models);
    }
    return res.models;
  }, []);

  return { loginState, start, refreshStatus, cancel, refreshModels };
}
