import { useCallback } from 'react';
import type {
  FilesListRequestPayload,
  FilesListResponsePayload,
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

/**
 * One-shot file browser commands. Pure request/response — no
 * subscriptions, no streaming — so this is just a thin wrapper around
 * `bus.command`. Mirrors `useTerminalOps` so callers can pass
 * `getActiveBus` in single-agent mode or a multi-agent bus getter.
 */
export function useFileOps(getBus: () => MessageBusClient | null) {
  const sendCommand = useCallback(
    <R, P = unknown>(verb: string, payload: P, timeoutMs = 15000): Promise<R> => {
      const bus = getBus();
      if (!bus) return Promise.reject(new Error('Not connected'));
      return bus.command<R, P>(verb, payload, { timeoutMs, queueWhileDisconnected: true });
    },
    [getBus],
  );

  const listFiles = useCallback(
    (payload: FilesListRequestPayload) =>
      sendCommand<FilesListResponsePayload>('files:list', payload),
    [sendCommand],
  );

  const readFile = useCallback(
    (payload: FilesReadRequestPayload) =>
      sendCommand<FilesReadResponsePayload>('files:read', payload),
    [sendCommand],
  );

  return { listFiles, readFile };
}
