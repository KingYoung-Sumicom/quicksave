import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalOutputSnapshot, TerminalOutputChunk } from '@sumicom/quicksave-shared';
import { useTerminalOps } from '../../hooks/useTerminalOps';
import { getActiveBus } from '../../lib/busRegistry';

interface TerminalViewProps {
  terminalId: string;
  /** Called when the underlying terminal closes so parent can navigate away. */
  onExit?: () => void;
}

/**
 * Pin the terminal to a fixed 80-column width and scale the font so those
 * 80 cols fill the container horizontally. Rows are derived from available
 * height at the resulting cell height.
 *
 * Iterates a few times because FitAddon reports cols/rows in integers: a
 * naïve `newFont = font * (cols / 80)` may round to the wrong integer, so
 * we apply it, refit, and repeat until cols locks on to 80 (or we run out
 * of budget).
 */
const STANDARD_COLS = 80;
const MIN_FONT_SIZE = 6;

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
    const next = Math.max(MIN_FONT_SIZE, Math.round(font * scale * 10) / 10);
    if (Math.abs(next - font) < 0.1) break;
    font = next;
    term.options.fontSize = next;
  }
  // Final fit + force exact cols (rounding may leave us at 79 or 81).
  try {
    fit.fit();
  } catch { /* container not ready */ }
  if (term.cols !== STANDARD_COLS) term.resize(STANDARD_COLS, term.rows);
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
export function TerminalView({ terminalId, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seqRef = useRef(0);
  const { sendInput, resizeTerminal, subscribeOutput } = useTerminalOps(getActiveBus);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [connected, setConnected] = useState(false);

  // Mount xterm once per terminalId.
  useEffect(() => {
    if (!containerRef.current) return;
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
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const pushSize = () => {
      resizeTerminal(terminalId, term.cols, term.rows).catch(() => {
        /* best effort — next output will work with whatever size the agent had */
      });
    };

    // Kick off an initial fit once layout has happened.
    requestAnimationFrame(() => {
      fitToStandardCols(term, fit);
      pushSize();
    });

    const onData = term.onData((chunk) => {
      sendInput(terminalId, chunk).catch((err) =>
        console.warn('[terminal] input failed:', err),
      );
    });

    const ro = new ResizeObserver(() => {
      fitToStandardCols(term, fit);
      pushSize();
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      onData.dispose();
      ro.disconnect();
      term.dispose();
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
    setConnected(false);

    const applySnapshot = (snapshot: TerminalOutputSnapshot | null) => {
      const t = termRef.current;
      if (!t) return;
      setConnected(true);
      // Reset so resubscribes (after reconnect) redraw cleanly.
      t.reset();
      if (!snapshot) {
        t.writeln('\x1b[31m[terminal not found]\x1b[0m');
        return;
      }
      if (snapshot.buffer.length > 0) t.write(snapshot.buffer);
      seqRef.current = snapshot.seq;
      if (snapshot.exited) setExitCode(snapshot.exitCode ?? null);
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

  // Virtual keys for mobile — hide on desktop.
  const sendKey = useCallback((seq: string) => {
    sendInput(terminalId, seq).catch((err) =>
      console.warn('[terminal] key send failed:', err),
    );
    termRef.current?.focus();
  }, [sendInput, terminalId]);

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
      termRef.current?.focus();
    } catch (err) {
      // Safari / iOS may reject without a user-activation gesture; the error
      // message is the only hint we get.
      setPasteError(err instanceof Error ? err.message : 'Paste failed');
    }
  }, [sendInput, terminalId]);

  // Native paste (iOS/Android long-press menu, desktop Ctrl+V) — bypasses
  // clipboard API permissions because the browser delivers the text directly.
  const onContainerPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    sendInput(terminalId, text).catch((err) =>
      console.warn('[terminal] paste send failed:', err),
    );
  }, [sendInput, terminalId]);

  return (
    <div className="flex flex-col h-full bg-slate-900">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full overflow-hidden"
        onClick={() => termRef.current?.focus()}
        onPaste={onContainerPaste}
      />
      <VirtualKeys
        onKey={sendKey}
        onPaste={handlePaste}
        pasteError={pasteError}
        connected={connected}
        exited={exitCode !== undefined}
      />
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
    <div className="border-t border-slate-700 bg-slate-900/80 safe-area-bottom">
      {pasteError && (
        <p className="px-3 pt-1 text-[11px] text-red-400 truncate">{pasteError}</p>
      )}
      <div className="flex flex-wrap gap-2 px-3 py-2">
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
    'shrink-0 min-w-[44px] px-3 py-2 rounded-md text-sm font-mono border border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700 disabled:opacity-40';
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
