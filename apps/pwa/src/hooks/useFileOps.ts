// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback } from 'react';
import type {
  FilesListRequestPayload,
  FilesListResponsePayload,
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { readWithCache } from '../lib/fileCache';
import { readFileViaRtc, type FileRtcReadOptions } from '../lib/fileRtcClient';

interface UseFileOpsOptions {
  queueWhileDisconnected?: boolean;
}

/**
 * One-shot file browser commands. Pure request/response — no
 * subscriptions, no streaming — so this is just a thin wrapper around
 * `bus.command`. Callers pass a bus getter that is already scoped to the
 * owning agent.
 */
export function useFileOps(
  getBus: () => MessageBusClient | null,
  options: UseFileOpsOptions = {},
) {
  const queueWhileDisconnected = options.queueWhileDisconnected ?? true;
  const sendCommand = useCallback(
    <R, P = unknown>(verb: string, payload: P, timeoutMs = 15000): Promise<R> => {
      const bus = getBus();
      if (!bus) return Promise.reject(new Error('Not connected'));
      return bus.command<R, P>(verb, payload, { timeoutMs, queueWhileDisconnected });
    },
    [getBus, queueWhileDisconnected],
  );

  const listFiles = useCallback(
    (payload: FilesListRequestPayload) =>
      sendCommand<FilesListResponsePayload>('files:list', payload),
    [sendCommand],
  );

  const readFile = useCallback(
    (payload: FilesReadRequestPayload, readOptions: FileRtcReadOptions = {}) =>
      readWithCache(payload, async (p) => {
        const metadata = await sendCommand<FilesReadResponsePayload>('files:read', p);
        if (!metadata.success || metadata.notModified || metadata.kind !== 'oversized') return metadata;
        const bus = getBus();
        if (!bus) return { ...metadata, transferError: 'Not connected' };
        try {
          return await readFileViaRtc(bus, p, readOptions);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return {
            ...metadata,
            transferError: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    [getBus, sendCommand],
  );

  return { listFiles, readFile };
}
