// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// OpenCode headless-server lifecycle.
//
// We spawn `opencode serve --port 0` lazily on first OpenCodeProvider call
// and keep it alive for the rest of the daemon's lifetime. One server backs
// every opencode session in this daemon — it handles its own session DB,
// SSE multiplexing, and provider/model resolution. Quicksave only needs to:
//   1. Create sessions (POST /session)
//   2. Send prompts (POST /session/{id}/prompt_async)
//   3. Subscribe to /event (one SSE stream, fan out by sessionID)
//   4. Abort / delete on close
//
// Restart policy: if the child exits unexpectedly we mark `ready = null`
// and let the next caller re-spawn. We don't attempt mid-turn recovery —
// the affected session just sees a streamEnd with success=false.
import { spawn, type ChildProcess } from 'child_process';
import { getOpenCodeBin } from './openCodeProvider.js';

/** Shape of a single SSE envelope from `/event`. */
export interface OpenCodeEvent {
  id: string;
  type: string;
  properties: Record<string, unknown> & { sessionID?: string };
}

export interface CreateSessionOpts {
  directory: string;
  title?: string;
  agent?: string;
}

export interface PromptOpts {
  messageID?: string;
  text: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
}

export interface PromptPart {
  type: 'text';
  text: string;
}

class OpenCodeServer {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;
  private sseAbort: AbortController | null = null;
  private shuttingDown = false;

  /** Per-sessionID listeners. Each call registers; returns disposer. */
  private listeners = new Map<string, Set<(event: OpenCodeEvent) => void>>();
  /** Global listeners (every event regardless of sessionID). */
  private globalListeners = new Set<(event: OpenCodeEvent) => void>();

  /** Ensure the server is up. Idempotent; concurrent callers share the spawn. */
  async ensureRunning(): Promise<{ baseUrl: string }> {
    if (this.port && this.proc && !this.proc.killed) {
      return { baseUrl: `http://127.0.0.1:${this.port}` };
    }
    if (!this.startPromise) this.startPromise = this.spawnAndAwaitReady();
    await this.startPromise;
    if (!this.port) throw new Error('opencode server failed to report a port');
    return { baseUrl: `http://127.0.0.1:${this.port}` };
  }

  private spawnAndAwaitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const bin = getOpenCodeBin();
      // --port 0  → let kernel pick a free port; we parse it from stdout.
      // --hostname 127.0.0.1 (default) keeps the server localhost-only.
      // --print-logs forces the "listening on …" banner to stderr where we
      // can read it; without it the banner only goes to ~/.local/share log
      // files and we'd have to poll.
      const proc = spawn(bin, ['serve', '--port', '0', '--print-logs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(process.env.OPENCODE_API_KEY ? { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY } : {}),
          ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        },
      });
      this.proc = proc;

      const onLine = (chunk: Buffer) => {
        const text = chunk.toString();
        // Banner format: "opencode server listening on http://127.0.0.1:NNNN"
        const m = text.match(/listening on https?:\/\/[^:]+:(\d+)/);
        if (m && m[1]) {
          this.port = Number(m[1]);
          proc.stdout?.off('data', onLine);
          proc.stderr?.off('data', onLine);
          // Start the SSE multiplexer in the background once the port is known.
          void this.startEventStream();
          resolve();
        }
      };
      proc.stdout?.on('data', onLine);
      proc.stderr?.on('data', onLine);

      proc.on('error', (err) => {
        if (this.port) return; // already resolved
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        const wasReady = !!this.port;
        this.port = null;
        this.proc = null;
        this.startPromise = null;
        const ac = this.sseAbort;
        this.sseAbort = null;
        ac?.abort();
        if (!wasReady) {
          reject(new Error(`opencode serve exited before ready (code=${code} signal=${signal})`));
        }
        if (!this.shuttingDown) {
          console.warn(`[openCode:server] exited unexpectedly code=${code} signal=${signal}`);
          // Synthesise a "disposed" event so per-session consumers can give
          // up cleanly instead of waiting forever.
          this.broadcast({
            id: `local-${Date.now()}`,
            type: 'server.disposed',
            properties: {},
          });
        }
      });

      // Spawn timeout — the docs claim < 1s start, but cold-start with
      // many plugins can take longer. 15s is generous.
      setTimeout(() => {
        if (!this.port) {
          reject(new Error('opencode serve did not report a port within 15s'));
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
      }, 15_000);
    });
  }

  /** Connect to /event as a long-lived SSE stream. Auto-reconnects until shutdown. */
  private async startEventStream(): Promise<void> {
    if (!this.port) return;
    const ac = new AbortController();
    this.sseAbort = ac;
    const baseUrl = `http://127.0.0.1:${this.port}`;
    while (!ac.signal.aborted && this.port) {
      try {
        const resp = await fetch(`${baseUrl}/event`, { signal: ac.signal });
        if (!resp.ok || !resp.body) {
          throw new Error(`/event returned ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!ac.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by blank lines; each `data:` line is
          // JSON. Multi-line `data:` blocks are joined with '\n'.
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.handleSseFrame(frame);
          }
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        console.warn('[openCode:server] SSE stream error, retrying in 1s:', err);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private handleSseFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join('\n')) as OpenCodeEvent;
      this.broadcast(event);
    } catch {
      // Non-JSON keep-alive frames etc. — ignore.
    }
  }

  private broadcast(event: OpenCodeEvent): void {
    for (const listener of this.globalListeners) {
      try { listener(event); } catch (err) { console.error('[openCode:server] global listener error', err); }
    }
    const sid = event.properties?.sessionID;
    if (typeof sid === 'string') {
      const set = this.listeners.get(sid);
      if (set) for (const l of set) {
        try { l(event); } catch (err) { console.error('[openCode:server] session listener error', err); }
      }
    }
  }

  /** Subscribe to events for one session. Returns a disposer. */
  subscribe(sessionID: string, listener: (event: OpenCodeEvent) => void): () => void {
    let set = this.listeners.get(sessionID);
    if (!set) { set = new Set(); this.listeners.set(sessionID, set); }
    set.add(listener);
    return () => {
      const s = this.listeners.get(sessionID);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(sessionID);
    };
  }

  /** Subscribe to every event (used by tests / debugging). */
  subscribeAll(listener: (event: OpenCodeEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => { this.globalListeners.delete(listener); };
  }

  // ── REST helpers ───────────────────────────────────────────────────────────

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { baseUrl } = await this.ensureRunning();
    const resp = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) {
      let body = '';
      try { body = await resp.text(); } catch { /* ignore */ }
      throw new Error(`opencode ${init.method ?? 'GET'} ${path} failed: ${resp.status} ${body.slice(0, 500)}`);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  async createSession(opts: CreateSessionOpts): Promise<{ id: string }> {
    const body: Record<string, unknown> = { directory: opts.directory };
    if (opts.title) body.title = opts.title;
    if (opts.agent) body.agent = opts.agent;
    return this.req<{ id: string }>('/session', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.req<unknown>(`/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' });
  }

  async sendPromptAsync(sessionID: string, opts: PromptOpts): Promise<void> {
    const body: Record<string, unknown> = {
      model: { providerID: opts.model.providerID, modelID: opts.model.modelID },
      parts: [{ type: 'text', text: opts.text }],
    };
    if (opts.messageID) body.messageID = opts.messageID;
    if (opts.agent) body.agent = opts.agent;
    if (opts.variant) body.variant = opts.variant;
    if (opts.system) body.system = opts.system;
    await this.req<unknown>(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Fetch every message + part for a session via the REST API.
   *
   * Tool calls in opencode 1.14 are NOT pushed via SSE — only `message.part.delta`
   * (text/reasoning), `session.status`, `session.diff`, and `session.idle` ever
   * appear on `/event`. The authoritative list of tool parts (with `input`,
   * `output`, `state.status`) lives only on `GET /session/{id}/message`.
   *
   * Shape:
   *   [{ info: { id, role, ... }, parts: [{ type: 'tool'|'text'|..., ... }] }]
   */
  async getMessages(sessionID: string): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    return this.req<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>(`/session/${encodeURIComponent(sessionID)}/message`);
  }

  async abortSession(sessionID: string): Promise<void> {
    try {
      await this.req<unknown>(`/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST' });
    } catch (err) {
      // Aborting a session that's already idle returns 400 — tolerate it.
      console.debug('[openCode:server] abort returned error (probably already idle)', err);
    }
  }

  async replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    await this.req<unknown>(`/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply }),
    });
  }

  /** Shutdown the server. Idempotent.
   *
   * Awaits actual child exit. Without this, callers (notably the daemon's
   * SIGTERM handler) `process.exit()` the moment SIGTERM was *sent*, leaving
   * the opencode child reparented to PID 1 — that's how we ended up with 8
   * orphaned `opencode serve` processes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.sseAbort?.abort();
    this.sseAbort = null;
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    this.startPromise = null;
    this.listeners.clear();
    this.globalListeners.clear();
    if (!proc || proc.killed || proc.exitCode !== null) return;

    // Polite HTTP dispose first (may quietly fail if server already gone).
    try { await this.req<unknown>('/global/dispose', { method: 'POST' }).catch(() => {}); }
    catch { /* ignore */ }
    if (proc.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    const killer = setTimeout(() => {
      if (proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3_000);
    await exited;
    clearTimeout(killer);
  }

  /** @internal for tests */
  get _port(): number | null { return this.port; }
}

let _instance: OpenCodeServer | null = null;

export function getOpenCodeServer(): OpenCodeServer {
  if (!_instance) _instance = new OpenCodeServer();
  return _instance;
}

/** Test-only: blow away the singleton (won't shut down a running server). */
export function _resetOpenCodeServer(): void {
  _instance = null;
}

export type { OpenCodeServer };
