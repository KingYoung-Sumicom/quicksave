// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalOutputSnapshot, TerminalOutputChunk } from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useTerminalOps } from '../../hooks/useTerminalOps';
import { useMediaQuery } from '../../hooks/useMediaQuery';

interface TerminalViewProps {
  terminalId: string;
  /**
   * Resolves the bus for the agent that owns this terminal. Must NOT be
   * `getActiveBus` — see TerminalPage for why.
   */
  getBus: () => MessageBusClient | null;
  /** Called when the underlying terminal closes so parent can navigate away. */
  onExit?: () => void;
  /** Fill the host height. Disable for embedded chat drawers that grow from xterm content. */
  fillHeight?: boolean;
}

/**
 * Pin the terminal to a fixed 80-column width and scale the font so those
 * 80 cols exactly fill the container WIDTH. Rows are then locked to 24 at
 * that font: the grid takes its natural height and the host (a vertically
 * scrollable wrapper) lets the user reach all 24 rows when the available
 * height is short (mobile portrait + soft keyboard). We deliberately do NOT
 * shrink the font to make 24 rows fit the height — width is the priority, so
 * 80 cols always fill the screen and the content expands downward.
 *
 * Iterates a few times because FitAddon reports cols in integers: a naïve
 * `newFont = font * (cols / 80)` may round to the wrong integer, so we apply
 * it, refit, and repeat until cols locks on to 80 (or we run out of budget).
 */
const STANDARD_COLS = 80;
/**
 * Lock rows to 24 (classic VT100) for consistent rendering of TUI tools
 * (vim, top, less, fzf) — they paint to whatever rows the PTY reports and
 * look very different at 50+ rows or at a truncated 15.
 */
const STANDARD_ROWS = 24;
const MIN_FONT_SIZE = 6;
/**
 * Cap the auto-scaled font so that on a wide desktop window the terminal
 * doesn't blow up to giant lettering. Above this we stop scaling up and
 * just leave horizontal margin (cols stay at 80 — see end of fit).
 */
const MAX_FONT_SIZE = 16;

function fitToStandardCols(term: Terminal, fit: FitAddon): void {
  let font = term.options.fontSize ?? 13;
  for (let i = 0; i < 6; i++) {
    try {
      fit.fit();
    } catch {
      return;
    }
    const cols = term.cols;
    if (cols === STANDARD_COLS) break;
    const scale = cols / STANDARD_COLS;
    const next = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, Math.round(font * scale * 10) / 10),
    );
    if (Math.abs(next - font) < 0.1) break;
    font = next;
    term.options.fontSize = next;
  }
  // Lock to exactly 80×24. cols fill the width (clamped on wide screens);
  // the 24 rows take their natural height at that font and the scrollable
  // wrapper handles any vertical overflow.
  try {
    fit.fit();
  } catch { /* container not ready */ }
  if (term.cols !== STANDARD_COLS || term.rows !== STANDARD_ROWS) {
    term.resize(STANDARD_COLS, STANDARD_ROWS);
  }
}

/**
 * xterm.js view for one PTY. Subscribes to `/terminals/:id/output`, seeds
 * the buffer from the snapshot (scrollback), and pipes updates into the
 * running terminal. Writes keystrokes back via `terminal:input`.
 *
 * Resize strategy:
 *   - FitAddon measures the host element and picks cols/rows.
 *   - A ResizeObserver refits whenever the container's size changes.
 *   - Every fit sends `terminal:resize` to the agent.
 */
export function TerminalView({ terminalId, getBus, onExit, fillHeight = true }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seqRef = useRef(0);
  // True while we're feeding a reconnect snapshot back through xterm.write().
  // The snapshot is the historical PTY byte stream and contains queries the
  // running TUI sent earlier (DSR `CSI 6n`, DA1 `CSI c`, OSC 11 `?`, ...).
  // xterm auto-replies to those queries via onData; without this gate, every
  // resume from background would re-inject those replies as fresh input,
  // and the user sees `^[[24;80R^[[?1;2c…` typed into their shell.
  const replayingSnapshotRef = useRef(false);
  const { sendInput, resizeTerminal, subscribeOutput } = useTerminalOps(getBus);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  // Optimistic: assume the terminal we just navigated to exists. Without
  // this, the brief window between mount and the first snapshot arrival
  // leaves VirtualKeys disabled, and a fast tap on a virtual key gets
  // swallowed. applySnapshot demotes us to false if the agent reports the
  // terminal is gone.
  const [connected, setConnected] = useState(true);

  // Mount xterm once per terminalId.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // xterm's dispose() removes event listeners but does NOT remove the
    // helper textarea / char-measure span / .xterm div it appended in open().
    // On a fresh React mount the container is a new DOM node so this is a
    // no-op, but StrictMode's mount→cleanup→mount cycle reuses the same
    // container; without this, the second open() stacks DOM on top of
    // orphans from the disposed first instance and the terminal renders
    // black. Clear at both ends to be safe.
    container.replaceChildren();
    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"Menlo", "SF Mono", "DejaVu Sans Mono", "Consolas", "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: {
        background: '#0f172a', // slate-900 — matches app chrome
        foreground: '#e2e8f0', // slate-200
        cursor: '#94a3b8',
        selectionBackground: '#334155',
      },
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    // iOS Safari quirk: the on-screen keyboard's default "return" key has
    // `enterkeyhint=enter`, which dismisses the keyboard whenever the user
    // hits it. xterm's helper textarea doesn't override this, so typing
    // Enter in a shell tears down the keyboard mid-session and the user
    // has to re-tap the terminal. Setting `enterkeyhint="send"` keeps the
    // keyboard up and just delivers the keystroke. Also set
    // `autocapitalize`/`autocorrect`/`spellcheck` off so iOS doesn't fight
    // the shell with autocorrect popups.
    const ta = term.textarea;
    if (ta) {
      ta.setAttribute('enterkeyhint', 'send');
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('spellcheck', 'false');
    }

    // Debounce resize cmds. ResizeObserver and the fit RAF can fire many
    // times during a single layout shift (iOS keyboard slide-in, window
    // drag, font-size loop in fitToStandardCols), and each call sends a
    // round-trip terminal:resize. The agent only cares about the final
    // size, so coalesce all calls within ~150ms into the last one. This
    // prevents bursty resize traffic from eating the relay's per-peer
    // message quota.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const pushSize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        resizeTerminal(terminalId, term.cols, term.rows).catch(() => {
          /* best effort — next output will work with whatever size the agent had */
        });
      }, 150);
    };

    // Kick off an initial fit once layout has happened.
    requestAnimationFrame(() => {
      fitToStandardCols(term, fit);
      pushSize();
    });

    const onData = term.onData((chunk) => {
      if (replayingSnapshotRef.current) return;
      sendInput(terminalId, chunk).catch((err) =>
        console.warn('[terminal] input failed:', err),
      );
    });

    const ro = new ResizeObserver(() => {
      fitToStandardCols(term, fit);
      pushSize();
    });
    ro.observe(container);

    return () => {
      onData.dispose();
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      term.dispose();
      container.replaceChildren();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Subscribe to output. Re-run only when terminalId changes; inner state
  // is captured via refs so the subscription doesn't reset on every render.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    seqRef.current = 0;
    setExitCode(undefined);

    const applySnapshot = (snapshot: TerminalOutputSnapshot | null) => {
      const t = termRef.current;
      if (!t) return;
      // Gate onData → terminal:input forwarding for the duration of the
      // replay. xterm.write() is async (parser runs on a microtask), so we
      // only clear the flag from the write callback. See the ref's docstring
      // for why this matters.
      replayingSnapshotRef.current = true;
      // Reset so resubscribes (after reconnect) redraw cleanly.
      t.reset();
      if (!snapshot) {
        replayingSnapshotRef.current = false;
        setConnected(false);
        t.writeln('\x1b[31m[terminal not found]\x1b[0m');
        return;
      }
      setConnected(true);
      if (snapshot.buffer.length > 0) {
        t.write(snapshot.buffer, () => {
          replayingSnapshotRef.current = false;
        });
      } else {
        replayingSnapshotRef.current = false;
      }
      seqRef.current = snapshot.seq;
      if (snapshot.exited) setExitCode(snapshot.exitCode ?? null);
      // The initial fit in `useEffect` runs before xterm has measured its
      // font (the renderer measures lazily on first paint), so FitAddon
      // sees `cell.width === 0` and silently no-ops, leaving the terminal
      // stuck at the default 80×24 dims. Refit now that the buffer write
      // has forced a measurement so cell dims are valid.
      const fit = fitRef.current;
      if (fit) {
        requestAnimationFrame(() => {
          const t2 = termRef.current;
          const f2 = fitRef.current;
          if (!t2 || !f2) return;
          fitToStandardCols(t2, f2);
        });
      }
    };

    const applyChunk = (chunk: TerminalOutputChunk) => {
      const t = termRef.current;
      if (!t) return;
      // Ignore already-applied chunks — possible if the snapshot arrived
      // after a chunk we also received on the same tick.
      if (chunk.seq <= seqRef.current) return;
      seqRef.current = chunk.seq;
      t.write(chunk.chunk);
      if (chunk.exited) setExitCode(chunk.exitCode ?? null);
    };

    const unsub = subscribeOutput(terminalId, {
      onSnapshot: applySnapshot,
      onChunk: applyChunk,
      onError: (err) => {
        // Don't pollute xterm — the bus auto-retries on reconnect, and a
        // transient "Not connected" during PWA resume is normal.
        console.warn('[terminal] subscription error:', err);
      },
    });

    return () => {
      try { unsub(); } catch { /* ignore */ }
    };
  }, [terminalId, subscribeOutput]);

  // Bubble up exit so the parent can auto-navigate after a delay.
  const handleExit = onExit;
  useEffect(() => {
    if (exitCode === undefined) return;
    if (!handleExit) return;
    const t = setTimeout(() => handleExit(), 3000);
    return () => clearTimeout(t);
  }, [exitCode, handleExit]);

  // Virtual keys exist only because a touch device's soft keyboard has no
  // Ctrl/Tab/Esc/arrow keys. On a device with a fine pointer (desktop with
  // a physical keyboard) they're redundant clutter, so hide them there.
  // `(pointer: coarse)` keys off the primary input being touch rather than
  // viewport width, so a narrowed desktop window keeps its physical-keyboard
  // experience while a wide tablet still gets the virtual row.
  const isTouch = useMediaQuery('(pointer: coarse)');

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isTouch || exitCode !== undefined) return;
    const raf = requestAnimationFrame(focusTerminal);
    return () => cancelAnimationFrame(raf);
  }, [focusTerminal, isTouch, exitCode, terminalId]);

  const handleTerminalPointerDown = useCallback(() => {
    if (isTouch) focusTerminal();
  }, [focusTerminal, isTouch]);

  const sendKey = useCallback((seq: string) => {
    sendInput(terminalId, seq).catch((err) =>
      console.warn('[terminal] key send failed:', err),
    );
    focusTerminal();
  }, [focusTerminal, sendInput, terminalId]);

  const [pasteError, setPasteError] = useState<string | null>(null);
  const handlePaste = useCallback(async () => {
    setPasteError(null);
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setPasteError('Clipboard read not supported — use long-press paste');
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await sendInput(terminalId, text);
      focusTerminal();
    } catch (err) {
      // Safari / iOS may reject without a user-activation gesture; the error
      // message is the only hint we get.
      setPasteError(err instanceof Error ? err.message : 'Paste failed');
    }
  }, [focusTerminal, sendInput, terminalId]);

  // Native paste (iOS/Android long-press menu, desktop Ctrl+V) — bypasses
  // clipboard API permissions because the browser delivers the text directly.
  const onContainerPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    sendInput(terminalId, text).catch((err) =>
      console.warn('[terminal] paste send failed:', err),
    );
    focusTerminal();
  }, [focusTerminal, sendInput, terminalId]);

  const intrinsicHeight = isTouch || !fillHeight;

  return (
    // On touch/embedded views the height flows from xterm's 80x24 screen
    // (+ the key row), so the root must NOT be h-full. Desktop keeps h-full
    // to fill its full-screen host.
    <div className={`flex flex-col bg-slate-900${intrinsicHeight ? '' : ' h-full'}`}>
      {/* Full-screen hosts may need this area to scroll within the fixed app
          frame. Embedded drawer views grow naturally so the chat list remains
          the only vertical scroll surface. Width never scrolls. */}
      <div className={intrinsicHeight
        ? 'w-full overflow-x-hidden'
        : 'flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden'}
      >
        {/* On touch/embedded views the xterm mount is width-driven: `w-full`
            gives it a definite width, and xterm's own 80x24 screen height
            grows the drawer. Desktop keeps the full-bleed fill. */}
        <div
          ref={containerRef}
          className={
            intrinsicHeight
              ? 'terminal-center w-full overflow-hidden'
              : 'terminal-center h-full w-full overflow-hidden'
          }
          onPointerDown={handleTerminalPointerDown}
          onClick={focusTerminal}
          onPaste={onContainerPaste}
        />
      </div>
      {isTouch && (
        <VirtualKeys
          onKey={sendKey}
          onPaste={handlePaste}
          pasteError={pasteError}
          connected={connected}
          exited={exitCode !== undefined}
        />
      )}
    </div>
  );
}

/**
 * Touch-friendly modifier row: the on-screen keyboard on iOS/Android has no
 * Ctrl/Tab/Esc/Arrow keys, which makes even `ls | less` impossible. These
 * buttons send the raw bytes a physical keyboard would.
 */
function VirtualKeys({
  onKey,
  onPaste,
  pasteError,
  connected,
  exited,
}: {
  onKey: (seq: string) => void;
  onPaste: () => void;
  pasteError: string | null;
  connected: boolean;
  exited: boolean;
}) {
  const [ctrlMode, setCtrlMode] = useState(false);

  const send = (seq: string) => {
    if (!connected || exited) return;
    onKey(seq);
  };

  const ctrlChord = (letter: string) => {
    // Control codes: ctrl+a..z = 0x01..0x1a
    const lower = letter.toLowerCase();
    if (lower.length !== 1) return;
    const code = lower.charCodeAt(0) - 96;
    if (code < 1 || code > 26) return;
    send(String.fromCharCode(code));
    setCtrlMode(false);
  };

  return (
    <div className="border-t border-slate-700 bg-slate-900/80">
      {pasteError && (
        <p className="px-3 pt-1 text-[11px] text-red-400 truncate">{pasteError}</p>
      )}
      {/* Single non-wrapping row so the key bar can't grow to 2–3 lines and eat
          the terminal's vertical space on a narrow phone. Overflowing keys
          scroll horizontally instead of wrapping. */}
      <div className="flex flex-nowrap gap-2 px-3 py-1.5 overflow-x-auto">
      <KeyBtn
        className={ctrlMode ? 'ring-1 ring-blue-400' : ''}
        onClick={() => setCtrlMode((v) => !v)}
        disabled={!connected || exited}
      >
        Ctrl
      </KeyBtn>
      {ctrlMode ? (
        ['A', 'C', 'D', 'L', 'R', 'U', 'W', 'Z'].map((l) => (
          <KeyBtn key={l} onClick={() => ctrlChord(l)} disabled={!connected || exited}>
            ^{l}
          </KeyBtn>
        ))
      ) : (
        <>
          <KeyBtn onClick={() => send('\t')} disabled={!connected || exited}>Tab</KeyBtn>
          <KeyBtn onClick={() => send('\x1b')} disabled={!connected || exited}>Esc</KeyBtn>
          <KeyBtn onClick={() => send('\x1b[A')} disabled={!connected || exited}>↑</KeyBtn>
          <KeyBtn onClick={() => send('\x1b[B')} disabled={!connected || exited}>↓</KeyBtn>
          <KeyBtn onClick={() => send('\x1b[D')} disabled={!connected || exited}>←</KeyBtn>
          <KeyBtn onClick={() => send('\x1b[C')} disabled={!connected || exited}>→</KeyBtn>
          <KeyBtn onClick={() => send('|')} disabled={!connected || exited}>|</KeyBtn>
          <KeyBtn onClick={() => send('~')} disabled={!connected || exited}>~</KeyBtn>
          <KeyBtn onClick={() => send('/')} disabled={!connected || exited}>/</KeyBtn>
          <KeyBtn
            className="text-blue-300 border-blue-500/60"
            onClick={onPaste}
            disabled={!connected || exited}
          >
            📋 Paste
          </KeyBtn>
        </>
      )}
      </div>
    </div>
  );
}

/**
 * Virtual-key button that does NOT steal focus from the terminal's hidden
 * textarea. On mobile, any focus change collapses the soft keyboard — by
 * cancelling the default on pointerdown/mousedown we keep the textarea
 * focused, so the keyboard stays up between taps. The click event still
 * fires because it's dispatched independently.
 */
function KeyBtn({
  onClick,
  disabled,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const base =
    'shrink-0 min-w-[44px] px-3 py-1.5 rounded-md text-sm font-mono border border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700 disabled:opacity-40';
  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={className ? `${base} ${className}` : base}
    >
      {children}
    </button>
  );
}
