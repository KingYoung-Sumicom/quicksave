// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import { TerminalView } from './TerminalView';
import { getBusForAgent } from '../../lib/busRegistry';

interface CollapsibleTerminalPanelProps {
  terminalId: string;
  machineAgentId: string;
}

/**
 * Slim wrapper around `TerminalView` shown at the top of a chat session
 * whose provider owns a PTY (today: `claude-terminal`). Gives the user
 * direct keyboard access to the underlying `claude` TUI alongside the
 * structured card list below.
 *
 * The visible area is locked to a 5:3 aspect ratio — the natural pixel
 * ratio of a classic 80×24 VT100 (9×18 px cells = 720×432). Capped at
 * 50vh so a wide desktop window doesn't push the chat off-screen.
 *
 * Collapsed state persists per terminal id in localStorage so the user's
 * preference survives page reloads.
 */
export function CollapsibleTerminalPanel({ terminalId, machineAgentId }: CollapsibleTerminalPanelProps) {
  const storageKey = `quicksave:terminal-collapsed:${terminalId}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, collapsed ? '1' : '0'); } catch { /* */ }
  }, [collapsed, storageKey]);

  const getBus = useCallback(() => getBusForAgent(machineAgentId), [machineAgentId]);

  if (collapsed) {
    // Half-pill handle peeking out from under the app bar. Pressing it
    // re-opens the terminal. Centered horizontally; depth is small enough
    // that it doesn't compete with the chat content for vertical space.
    return (
      <div className="relative h-0">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Show terminal"
          title="Show terminal"
          className="absolute left-1/2 top-0 -translate-x-1/2 flex h-5 w-16 items-center justify-center rounded-b-full border border-t-0 border-slate-700 bg-slate-900/95 text-slate-400 shadow-md backdrop-blur transition hover:text-slate-100 hover:bg-slate-800"
        >
          <span aria-hidden className="text-xs leading-none">▾</span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative border-b-4 border-slate-700 bg-slate-950/60">
      {/* Aspect-locked terminal — never grows past 50vh to leave room for cards. */}
      <div className="mx-auto aspect-[5/3] max-h-[50vh] w-full bg-black">
        <TerminalView terminalId={terminalId} getBus={getBus} />
      </div>
      {/* Bottom half-circle handle straddling the divider; pressing it collapses
          the terminal. Mirrors the half-pill shown in the collapsed state. */}
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        aria-label="Hide terminal"
        title="Hide terminal"
        className="absolute bottom-0 left-1/2 z-10 flex h-4 w-16 -translate-x-1/2 translate-y-full items-center justify-center rounded-b-full border border-t-0 border-slate-700 bg-slate-900/95 text-slate-400 shadow-md backdrop-blur transition hover:bg-slate-800 hover:text-slate-100"
      >
        <span aria-hidden className="text-xs leading-none">▴</span>
      </button>
    </div>
  );
}
