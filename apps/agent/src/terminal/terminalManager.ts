/**
 * TerminalManager — owns a pool of PTY-backed shells the PWA can drive remotely.
 *
 * One manager instance per daemon. It spawns `node-pty` children, holds a
 * bounded scrollback buffer for each one, and emits events for the bus
 * layer to publish.
 *
 * State that matters for resume:
 *   - Scrollback buffer (raw output, including ANSI escapes) — so a PWA
 *     reconnecting can render the current screen without the shell having
 *     to redraw.
 *   - `seq`: monotonic byte counter, used so the PWA can reconcile a late
 *     snapshot against updates it already received.
 */

import { EventEmitter } from 'events';
import { homedir, platform } from 'os';
import { basename } from 'path';
import { randomBytes } from 'crypto';
import type {
  TerminalSummary,
  TerminalOutputSnapshot,
  TerminalOutputChunk,
  TerminalsUpdate,
} from '@sumicom/quicksave-shared';

// Lazy-require so typecheck works even if the native module failed to build
// on a dev box (we surface a clearer error at spawn time instead).
import type * as NodePtyModule from 'node-pty';

let ptyModulePromise: Promise<typeof NodePtyModule> | null = null;
async function loadPty(): Promise<typeof NodePtyModule> {
  if (!ptyModulePromise) {
    ptyModulePromise = import('node-pty');
  }
  return ptyModulePromise;
}

/** Upper bound on retained scrollback per terminal. 256KiB is plenty for a
 *  recent session without bloating the snapshot frame. */
const SCROLLBACK_LIMIT = 256 * 1024;

function generateTerminalId(): string {
  return `term_${randomBytes(6).toString('hex')}`;
}

function defaultShell(): string {
  const env = process.env.SHELL;
  if (env && env.length > 0) return env;
  return platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
}

function defaultShellArgs(shell: string): string[] {
  const base = basename(shell);
  // Run as a login shell so .profile / .zprofile / rc files load the user's
  // PATH — without this, interactive tools like nvm or asdf won't be found.
  if (base === 'bash' || base === 'zsh' || base === 'sh') return ['-l'];
  return [];
}

interface PtyEntry {
  terminalId: string;
  title: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  pty: NodePtyModule.IPty;
  /** Concatenated raw output, trimmed to SCROLLBACK_LIMIT. */
  buffer: string;
  /** Total bytes written so far — monotonic. */
  seq: number;
  exited: boolean;
  exitCode: number | null;
  /**
   * Pending PTY output coalescing: shells often emit several small chunks
   * for a single keystroke (echo + cursor move + line clear + prompt redraw).
   * We accumulate them in `pendingChunks` and emit one combined `output`
   * event per `OUTPUT_FLUSH_MS` window, drastically cutting the number of
   * relay frames per typing burst (the production relay rate-limits at
   * 100 msg/60s/peer; without batching, a few seconds of typing trips it).
   */
  pendingChunks: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Flush window for batched PTY output. 16ms is one ~60Hz frame — short
 * enough that interactive feel stays snappy, long enough that bursty
 * shells (prompt redraw, syntax highlighters) collapse into one frame.
 */
const OUTPUT_FLUSH_MS = 16;

function toSummary(entry: PtyEntry): TerminalSummary {
  return {
    terminalId: entry.terminalId,
    title: entry.title,
    cwd: entry.cwd,
    shell: entry.shell,
    cols: entry.cols,
    rows: entry.rows,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    exited: entry.exited,
    exitCode: entry.exitCode,
  };
}

interface CreateOptions {
  cwd: string;
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  title?: string;
}

export class TerminalManager extends EventEmitter {
  private readonly terminals = new Map<string, PtyEntry>();

  /**
   * Snapshot of every terminal summary — used by the `/terminals` bus
   * subscription on initial connect.
   */
  listSummaries(): TerminalSummary[] {
    return [...this.terminals.values()].map(toSummary);
  }

  /**
   * Snapshot for a single terminal's output stream — used by the
   * `/terminals/:terminalId/output` subscription.
   */
  outputSnapshot(terminalId: string): TerminalOutputSnapshot | null {
    const entry = this.terminals.get(terminalId);
    if (!entry) return null;
    return {
      terminalId,
      buffer: entry.buffer,
      seq: entry.seq,
      cols: entry.cols,
      rows: entry.rows,
      exited: entry.exited,
      exitCode: entry.exitCode,
    };
  }

  async create(opts: CreateOptions): Promise<TerminalSummary> {
    const pty = await loadPty();
    const shell = opts.shell && opts.shell.length > 0 ? opts.shell : defaultShell();
    const args = opts.args ?? defaultShellArgs(shell);
    const cols = Math.max(20, Math.floor(opts.cols ?? 80));
    const rows = Math.max(5, Math.floor(opts.rows ?? 24));
    const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : homedir();
    const title = opts.title?.trim() || basename(shell);

    const terminalId = generateTerminalId();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Signal to user shells that this is quicksave, so they can skip
      // heavy interactive features if they want.
      QUICKSAVE_TERMINAL: '1',
    };

    const child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as { [key: string]: string },
    });

    const now = Date.now();
    const entry: PtyEntry = {
      terminalId,
      title,
      cwd,
      shell,
      cols,
      rows,
      createdAt: now,
      lastActivityAt: now,
      pty: child,
      buffer: '',
      seq: 0,
      exited: false,
      exitCode: null,
      pendingChunks: '',
      flushTimer: null,
    };
    this.terminals.set(terminalId, entry);

    const flushPending = (extras?: Partial<TerminalOutputChunk>) => {
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
      }
      if (entry.pendingChunks.length === 0 && !extras) return;
      const data = entry.pendingChunks;
      entry.pendingChunks = '';
      const chunk: TerminalOutputChunk = {
        terminalId,
        seq: entry.seq,
        chunk: data,
        ...extras,
      };
      this.emit('output', chunk);
    };

    child.onData((data) => {
      entry.seq += data.length;
      entry.lastActivityAt = Date.now();
      entry.buffer += data;
      if (entry.buffer.length > SCROLLBACK_LIMIT) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - SCROLLBACK_LIMIT);
      }
      // Coalesce: accumulate into pendingChunks and arm a flush timer if
      // not already pending. The seq we emit on flush reflects bytes up to
      // the flush moment, which lines up with how the snapshot's seq is
      // computed (entry.seq at snapshot time).
      entry.pendingChunks += data;
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => flushPending(), OUTPUT_FLUSH_MS);
      }
      // Activity bump — title/lastActivityAt shows up on the list.
      this.emit('terminal-updated', toSummary(entry));
    });

    child.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
      const tail = `\r\n\x1b[2m[process exited${
        typeof exitCode === 'number' ? ` code=${exitCode}` : ''
      }${signal ? ` signal=${signal}` : ''}]\x1b[0m\r\n`;
      entry.seq += tail.length;
      entry.lastActivityAt = Date.now();
      entry.buffer += tail;
      if (entry.buffer.length > SCROLLBACK_LIMIT) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - SCROLLBACK_LIMIT);
      }
      // Append exit tail to any pending chunk and flush immediately so
      // subscribers see the exit promptly (no point waiting another 16ms).
      entry.pendingChunks += tail;
      flushPending({ exited: true, exitCode: entry.exitCode });
      this.emit('terminal-updated', toSummary(entry));
    });

    const summary = toSummary(entry);
    this.emit('terminals-updated', { kind: 'upsert', terminal: summary } satisfies TerminalsUpdate);
    return summary;
  }

  write(terminalId: string, data: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new Error(`Unknown terminal: ${terminalId}`);
    if (entry.exited) throw new Error(`Terminal has exited: ${terminalId}`);
    entry.pty.write(data);
    entry.lastActivityAt = Date.now();
  }

  resize(terminalId: string, cols: number, rows: number): TerminalSummary {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new Error(`Unknown terminal: ${terminalId}`);
    const newCols = Math.max(20, Math.floor(cols));
    const newRows = Math.max(5, Math.floor(rows));
    if (!entry.exited) entry.pty.resize(newCols, newRows);
    entry.cols = newCols;
    entry.rows = newRows;
    const summary = toSummary(entry);
    this.emit('terminal-updated', summary);
    this.emit('terminals-updated', { kind: 'upsert', terminal: summary } satisfies TerminalsUpdate);
    return summary;
  }

  rename(terminalId: string, title: string): TerminalSummary {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new Error(`Unknown terminal: ${terminalId}`);
    const cleaned = title.trim().slice(0, 80);
    entry.title = cleaned || basename(entry.shell);
    const summary = toSummary(entry);
    this.emit('terminal-updated', summary);
    this.emit('terminals-updated', { kind: 'upsert', terminal: summary } satisfies TerminalsUpdate);
    return summary;
  }

  close(terminalId: string, force = false): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new Error(`Unknown terminal: ${terminalId}`);
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    try {
      if (!entry.exited) {
        // Send SIGHUP first (graceful); fall back to SIGKILL if caller asked.
        entry.pty.kill(force ? 'SIGKILL' : 'SIGHUP');
      }
    } catch (err) {
      // Swallow — the onExit handler will fire regardless once the process is dead.
      console.warn(`[terminal] kill ${terminalId} failed:`, err);
    }
    this.terminals.delete(terminalId);
    this.emit('terminals-updated', { kind: 'remove', terminalId } satisfies TerminalsUpdate);
  }

  /** Kill every live terminal — invoked during daemon shutdown. */
  shutdown(): void {
    for (const id of [...this.terminals.keys()]) {
      try {
        this.close(id, true);
      } catch {
        /* best effort */
      }
    }
  }
}

let globalManager: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!globalManager) globalManager = new TerminalManager();
  return globalManager;
}

// Test seam — reset between tests that exercise the singleton directly.
export function _resetTerminalManagerForTest(): void {
  if (globalManager) globalManager.shutdown();
  globalManager = null;
}
