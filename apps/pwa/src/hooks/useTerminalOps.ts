// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback } from 'react';
import type {
  TerminalCreateRequestPayload,
  TerminalCreateResponsePayload,
  TerminalInputResponsePayload,
  TerminalResizeResponsePayload,
  TerminalCloseResponsePayload,
  TerminalRenameResponsePayload,
  TerminalOutputSnapshot,
  TerminalOutputChunk,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

/**
 * One-shot terminal commands + a factory for opening an output subscription
 * that the xterm view hooks up to.
 *
 * `getBus` returns the bus for the agent hosting the terminal. Callers pick
 * the right bus via `window.__buses` (set in App.tsx) or pass the active bus
 * for single-agent mode.
 */
export function useTerminalOps(getBus: () => MessageBusClient | null) {
  const sendCommand = useCallback(
    <R, P = unknown>(verb: string, payload: P, timeoutMs = 15000): Promise<R> => {
      const bus = getBus();
      if (!bus) return Promise.reject(new Error('Not connected'));
      return bus.command<R, P>(verb, payload, { timeoutMs, queueWhileDisconnected: true });
    },
    [getBus],
  );

  const createTerminal = useCallback(
    (payload: TerminalCreateRequestPayload) =>
      sendCommand<TerminalCreateResponsePayload>('terminal:create', payload),
    [sendCommand],
  );

  const sendInput = useCallback(
    (terminalId: string, data: string) =>
      sendCommand<TerminalInputResponsePayload>('terminal:input', { terminalId, data }),
    [sendCommand],
  );

  const resizeTerminal = useCallback(
    (terminalId: string, cols: number, rows: number) =>
      sendCommand<TerminalResizeResponsePayload>('terminal:resize', { terminalId, cols, rows }),
    [sendCommand],
  );

  const closeTerminal = useCallback(
    (terminalId: string, force = false) =>
      sendCommand<TerminalCloseResponsePayload>('terminal:close', { terminalId, force }),
    [sendCommand],
  );

  const renameTerminal = useCallback(
    (terminalId: string, title: string) =>
      sendCommand<TerminalRenameResponsePayload>('terminal:rename', { terminalId, title }),
    [sendCommand],
  );

  /**
   * Open the output stream for a single terminal. Snapshot delivers the
   * current scrollback (seed for the xterm buffer); each update is a chunk
   * of fresh output to `write()` into xterm.
   *
   * Resume-from-background safety: the bus may not exist yet when this is
   * called (mount race during reconnect, iOS PWA waking from full unload).
   * Instead of failing the subscription forever, we wait for the bus to
   * appear — checking on visibility/focus events plus a slow poll — and
   * only then call `bus.subscribe`. After that, the bus library itself
   * survives WebSocket disconnects (it re-sends `sub` on reconnect).
   */
  const subscribeOutput = useCallback(
    (
      terminalId: string,
      handlers: {
        onSnapshot: (snapshot: TerminalOutputSnapshot | null) => void;
        onChunk: (chunk: TerminalOutputChunk) => void;
        onError?: (err: Error) => void;
      },
    ): (() => void) => {
      let unsub: (() => void) | null = null;
      let cancelled = false;

      const tryAttach = () => {
        if (cancelled || unsub) return;
        const bus = getBus();
        if (!bus) return;
        unsub = bus.subscribe<TerminalOutputSnapshot | null, TerminalOutputChunk>(
          `/terminals/${terminalId}/output`,
          {
            onSnapshot: handlers.onSnapshot,
            onUpdate: handlers.onChunk,
            onError: handlers.onError
              ? (err: string) => handlers.onError?.(new Error(err))
              : undefined,
          },
        );
      };

      const onVisible = () => {
        if (typeof document !== 'undefined' && !document.hidden) tryAttach();
      };
      const onFocus = () => tryAttach();

      tryAttach();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', onFocus);
      }
      // Slow poll catches the case where neither focus nor visibility fires
      // (programmatic reconnect, WebSocket flip without tab change).
      const poll = setInterval(tryAttach, 1500);

      return () => {
        cancelled = true;
        clearInterval(poll);
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisible);
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('focus', onFocus);
        }
        if (unsub) {
          try { unsub(); } catch { /* ignore */ }
        }
      };
    },
    [getBus],
  );

  return {
    createTerminal,
    sendInput,
    resizeTerminal,
    closeTerminal,
    renameTerminal,
    subscribeOutput,
  };
}
