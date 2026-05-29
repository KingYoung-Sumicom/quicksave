// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tail a Claude session JSONL file (~/.claude/projects/<encoded-cwd>/<sid>.jsonl).
 *
 * The file is append-only; claude flushes per-message (we measured per-turn
 * latency for streaming text — see docs/plans/2026-05-25-claude-terminal-provider.md
 * for the probe results). We poll size and parse newly-appended bytes.
 *
 * `fs.watch` alone is unreliable on Linux for append-only writes (it may not
 * fire when the file grows but its metadata otherwise stays put), so we use
 * a 50 ms polling loop with a short fast-path when fs.watch *does* fire.
 *
 * Emits:
 *   - 'message' (parsed JSON object) — once per appended line
 *   - 'error' (Error) — on read failure (recoverable; we keep polling)
 */

import { EventEmitter } from 'node:events';
import { stat, open } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';

export class JsonlTail extends EventEmitter {
  readonly path: string;
  private offset: number;
  private buf: string = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private stopped = false;
  private inflight = false;

  /**
   * @param path - File path to tail. May not exist at construction; we'll
   *   poll for it to appear.
   * @param startOffset - Byte offset to start tailing from. Default 0 (read
   *   everything that exists when we first see the file). Pass a known size
   *   to skip past already-seen messages.
   */
  constructor(path: string, startOffset = 0) {
    super();
    this.path = path;
    this.offset = startOffset;
  }

  start(intervalMs = 50): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    // Trigger an immediate poll so callers don't wait `intervalMs` for the
    // first batch of existing content.
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* */ }
      this.watcher = null;
    }
  }

  /** Current byte offset — useful as the cutoff anchor when handing off to
   *  buildCardsFromHistory. */
  get currentOffset(): number {
    return this.offset;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inflight) return;
    this.inflight = true;
    try {
      let size: number;
      try {
        const s = await stat(this.path);
        size = s.size;
      } catch {
        // File doesn't exist yet — just keep polling.
        return;
      }

      // First-time-seen: arm fs.watch as a low-latency hint. fs.watch may
      // miss events but we have the polling loop as a safety net.
      if (!this.watcher) {
        try {
          this.watcher = watch(this.path, () => void this.poll());
        } catch { /* fs.watch unavailable — polling alone suffices */ }
      }

      if (size <= this.offset) return;
      const delta = size - this.offset;

      const fd = await open(this.path, 'r');
      try {
        const buf = Buffer.alloc(delta);
        await fd.read(buf, 0, delta, this.offset);
        this.offset = size;
        this.buf += buf.toString('utf8');
      } finally {
        await fd.close();
      }

      // Emit each complete line; keep any trailing partial line for the
      // next round (claude writes line-delimited JSON, but a flush may land
      // mid-line if it ever happens — we have not observed it).
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.emit('message', msg);
        } catch (err) {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inflight = false;
    }
  }
}
