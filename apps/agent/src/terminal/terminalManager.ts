// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * TerminalManager — owns a pool of PTY-backed shells the PWA can drive remotely.
 *
 * One manager instance per daemon. It spawns `node-pty` children, mirrors
 * each PTY into a bounded headless xterm screen, and emits events for the
 * bus layer to publish.
 *
 * State that matters for resume:
 *   - Serialized VT screen state, including scrollback and alternate screen,
 *     so a reconnecting PWA can restore the display without a shell redraw.
 *   - `seq`: monotonic UTF-16 code-unit count, used to reconcile a late
 *     snapshot against updates it already received.
 */

import { EventEmitter } from 'events';
import { homedir, platform } from 'os';
import { basename } from 'path';
import { randomBytes } from 'crypto';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
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

const { Terminal: HeadlessTerminalClass } = headless;
const { SerializeAddon } = serializeAddon;

/** Keep a bounded line history while preserving the current screen state. */
const SNAPSHOT_SCROLLBACK_ROWS = 1000;

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
  screen: HeadlessTerminal;
  serializer: SerializeAddonType;
  /** Total UTF-16 code units received so far — monotonic. */
  seq: number;
  /** Last sequence that the headless parser has finished applying. */
  renderedSeq: number;
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
  flushPending: (extras?: Partial<TerminalOutputChunk>) => void;
  pendingSnapshots: Set<(snapshot: TerminalOutputSnapshot | null) => void>;
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
  env?: NodeJS.ProcessEnv;
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
  outputSnapshot(terminalId: string): Promise<TerminalOutputSnapshot | null> {
    const entry = this.terminals.get(terminalId);
    if (!entry) return Promise.resolve(null);
    // End the current live chunk before taking a checkpoint. Any output that
    // arrives after this boundary belongs to a new chunk with a higher seq.
    entry.flushPending();
    return new Promise((resolve) => {
      entry.pendingSnapshots.add(resolve);
      // xterm parses writes asynchronously. The callback runs after every
      // write queued before this marker, so the serialized screen and seq
      // describe the same point in the output stream.
      entry.screen.write('', () => {
        if (!entry.pendingSnapshots.delete(resolve)) return;
        if (this.terminals.get(terminalId) !== entry) {
          resolve(null);
          return;
        }
        resolve({
          terminalId,
          buffer: entry.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS }),
          seq: entry.renderedSeq,
          cols: entry.cols,
          rows: entry.rows,
          exited: entry.exited,
          exitCode: entry.exitCode,
        });
      });
    });
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
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (value !== undefined) env[key] = String(value);
    }

    const child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as { [key: string]: string },
    });
    const screen = new HeadlessTerminalClass({
      cols,
      rows,
      scrollback: SNAPSHOT_SCROLLBACK_ROWS,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);

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
      screen,
      serializer,
      seq: 0,
      renderedSeq: 0,
      exited: false,
      exitCode: null,
      pendingChunks: '',
      flushTimer: null,
      flushPending: () => {},
      pendingSnapshots: new Set(),
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
    entry.flushPending = flushPending;

    child.onData((data) => {
      if (this.terminals.get(terminalId) !== entry) return;
      entry.seq += data.length;
      const writeSeq = entry.seq;
      entry.lastActivityAt = Date.now();
      entry.screen.write(data, () => { entry.renderedSeq = writeSeq; });
      // Coalesce: accumulate into pendingChunks and arm a flush timer if
      // not already pending. The seq we emit on flush covers all output in
      // the chunk; snapshots use the sequence parsed into the screen.
      entry.pendingChunks += data;
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => flushPending(), OUTPUT_FLUSH_MS);
      }
      // Activity bump — title/lastActivityAt shows up on the list.
      this.emit('terminal-updated', toSummary(entry));
    });

    child.onExit(({ exitCode, signal }) => {
      if (this.terminals.get(terminalId) !== entry) return;
      entry.exited = true;
      entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
      const tail = `\r\n\x1b[2m[process exited${
        typeof exitCode === 'number' ? ` code=${exitCode}` : ''
      }${signal ? ` signal=${signal}` : ''}]\x1b[0m\r\n`;
      entry.seq += tail.length;
      const writeSeq = entry.seq;
      entry.lastActivityAt = Date.now();
      entry.screen.write(tail, () => { entry.renderedSeq = writeSeq; });
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
    entry.screen.resize(newCols, newRows);
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
    // If kill fails, keep the entry reachable so the caller can retry and
    // the process does not become an untracked orphan.
    if (!entry.exited) entry.pty.kill(force ? 'SIGKILL' : 'SIGHUP');
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    this.terminals.delete(terminalId);
    for (const resolve of entry.pendingSnapshots) resolve(null);
    entry.pendingSnapshots.clear();
    entry.screen.dispose();
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
