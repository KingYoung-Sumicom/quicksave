// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// OpenCode headless-server lifecycle.
//
// We spawn `opencode serve --port 0` lazily on first OpenCodeProvider call
// and keep it alive for the rest of the daemon's lifetime. One server backs
// every opencode session in this daemon — it handles its own session DB,
// SSE multiplexing, and provider/model resolution. Quicksave only needs to:
//   1. Create directory-scoped sessions (POST /session?directory=…)
//   2. Send directory-scoped prompts (POST /session/{id}/prompt_async)
//   3. Subscribe to /global/event (one SSE stream, fan out by sessionID)
//   4. Abort / delete on close
//
// Restart policy: if the child exits unexpectedly we mark `ready = null`
// and let the next caller re-spawn. We don't attempt mid-turn recovery —
// the affected session just sees a streamEnd with success=false.
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { Attachment } from '@sumicom/quicksave-shared';
import { getOpenCodeBin } from './openCodeProvider.js';
import {
  DISPLAY_MARKDOWN_REPORT_TOOL,
  SANDBOX_BASH_TOOL,
  SANDBOX_MCP_PREFIX,
  UPDATE_SESSION_STATUS_TOOL,
  buildSandboxMcpServerConfig,
} from './sandboxMcp.js';

const __aiDir = dirname(fileURLToPath(import.meta.url));

/**
 * OpenCode exposes MCP tools as `<server>_<tool>`. This deliberately ends in
 * one underscore so its separator produces the canonical Quicksave tool name:
 * `mcp__quicksave-sandbox__UpdateSessionStatus`.
 */
export const OPENCODE_SANDBOX_MCP_NAME = SANDBOX_MCP_PREFIX.slice(0, -1);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse the JSONC accepted by OPENCODE_CONFIG_CONTENT without executing it. */
function parseOpenCodeConfigContent(content: string): Record<string, unknown> {
  let stripped = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (inString) {
      stripped += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      stripped += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++;
      stripped += ' ';
      continue;
    }
    stripped += ch;
  }

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (inString) {
      withoutTrailingCommas += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      withoutTrailingCommas += ch;
      continue;
    }
    if (ch === ',') {
      let nextIndex = i + 1;
      while (/\s/.test(stripped[nextIndex] ?? '')) nextIndex++;
      if (stripped[nextIndex] === '}' || stripped[nextIndex] === ']') continue;
    }
    withoutTrailingCommas += ch;
  }

  const parsed = JSON.parse(withoutTrailingCommas) as unknown;
  if (!isRecord(parsed)) throw new Error('OPENCODE_CONFIG_CONTENT must contain an object');
  return parsed;
}

export function buildOpenCodeQuicksaveConfig(
  existingContent: string | undefined,
  ownDir = __aiDir,
): Record<string, unknown> {
  const existing = existingContent?.trim()
    ? parseOpenCodeConfigContent(existingContent)
    : {};
  const mcp = buildSandboxMcpServerConfig({
    ownDir,
    cwd: '.',
    inheritCwd: true,
  });
  const tsPluginPath = join(ownDir, 'openCodeMcpPlugin.ts');
  const pluginPath = existsSync(tsPluginPath)
    ? tsPluginPath
    : join(ownDir, 'openCodeMcpPlugin.js');
  const existingPlugins = Array.isArray(existing.plugin) ? existing.plugin : [];
  const pluginUrl = pathToFileURL(pluginPath).href;
  const existingMcp = isRecord(existing.mcp) ? existing.mcp : {};
  const existingPermission = typeof existing.permission === 'string'
    ? { '*': existing.permission }
    : isRecord(existing.permission) ? existing.permission : {};

  return {
    ...existing,
    plugin: Array.from(new Set([...existingPlugins, pluginUrl])),
    mcp: {
      ...existingMcp,
      [OPENCODE_SANDBOX_MCP_NAME]: {
        type: 'local',
        command: [mcp.command, ...mcp.args],
        enabled: true,
        timeout: 130_000,
      },
    },
    permission: {
      ...existingPermission,
      [SANDBOX_BASH_TOOL]: 'allow',
      [UPDATE_SESSION_STATUS_TOOL]: 'allow',
      [DISPLAY_MARKDOWN_REPORT_TOOL]: 'allow',
    },
  };
}

export function buildOpenCodeServerEnv(
  env: NodeJS.ProcessEnv = process.env,
  ownDir = __aiDir,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      buildOpenCodeQuicksaveConfig(env.OPENCODE_CONFIG_CONTENT, ownDir),
    ),
  };
}

/** Shape of one OpenCode event (the payload inside `/global/event`). */
export interface OpenCodeEvent {
  id?: string;
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
  attachments?: readonly Attachment[];
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename?: string; url: string };

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
  models: Record<string, { id?: string; name?: string }>;
}

/** @internal exported for protocol-shape tests. */
export function buildOpenCodeUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

/** Convert Quicksave's staged attachments to OpenCode FilePartInput values. */
export function buildOpenCodePromptParts(
  text: string,
  attachments: readonly Attachment[] = [],
): PromptPart[] {
  const parts: PromptPart[] = [];
  if (text || attachments.length === 0) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    parts.push({
      type: 'file',
      mime: attachment.mimeType,
      filename: attachment.name,
      url: `data:${attachment.mimeType};base64,${attachment.data}`,
    });
  }
  return parts;
}

/** Event revisions disagree on whether sessionID is top-level or nested. */
export function getOpenCodeEventSessionId(event: OpenCodeEvent): string | undefined {
  const direct = event.properties?.sessionID;
  if (typeof direct === 'string') return direct;
  const part = event.properties?.part;
  if (part && typeof part === 'object' && 'sessionID' in part && typeof part.sessionID === 'string') {
    return part.sessionID;
  }
  const info = event.properties?.info;
  if (info && typeof info === 'object' && 'sessionID' in info && typeof info.sessionID === 'string') {
    return info.sessionID;
  }
  return undefined;
}

/** Build headers shared by REST and SSE, including optional server Basic Auth. */
export function buildOpenCodeRequestHeaders(
  includeJson = false,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeJson) headers['content-type'] = 'application/json';
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    const username = env.OPENCODE_SERVER_USERNAME || 'opencode';
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return headers;
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
        env: buildOpenCodeServerEnv(),
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
          // `/global/event` multiplexes every directory-backed instance owned
          // by this server. A plain `/event` stream is scoped to one directory.
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

  private requestHeaders(includeJson = false): Record<string, string> {
    return buildOpenCodeRequestHeaders(includeJson);
  }

  /** Connect to /global/event as a long-lived SSE stream. Auto-reconnects until shutdown. */
  private async startEventStream(): Promise<void> {
    if (!this.port) return;
    const ac = new AbortController();
    this.sseAbort = ac;
    const baseUrl = `http://127.0.0.1:${this.port}`;
    while (!ac.signal.aborted && this.port) {
      try {
        const resp = await fetch(`${baseUrl}/global/event`, {
          signal: ac.signal,
          headers: this.requestHeaders(),
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`/global/event returned ${resp.status}`);
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
      const parsed = JSON.parse(dataLines.join('\n')) as
        | OpenCodeEvent
        | { directory: string; payload: OpenCodeEvent };
      const event = (
        parsed
        && typeof parsed === 'object'
        && 'payload' in parsed
        && parsed.payload
        && typeof parsed.payload === 'object'
      ) ? parsed.payload : parsed as OpenCodeEvent;
      this.broadcast(event);
    } catch {
      // Non-JSON keep-alive frames etc. — ignore.
    }
  }

  private broadcast(event: OpenCodeEvent): void {
    for (const listener of this.globalListeners) {
      try { listener(event); } catch (err) { console.error('[openCode:server] global listener error', err); }
    }
    const sid = getOpenCodeEventSessionId(event);
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

  private async req<T>(
    path: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const { baseUrl } = await this.ensureRunning();
    const url = buildOpenCodeUrl(baseUrl, path, query);
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...this.requestHeaders(init.body !== undefined),
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) {
      let body = '';
      try { body = await resp.text(); } catch { /* ignore */ }
      throw new Error(`opencode ${init.method ?? 'GET'} ${url.pathname} failed: ${resp.status} ${body.slice(0, 500)}`);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  async createSession(opts: CreateSessionOpts): Promise<{ id: string }> {
    const body: Record<string, unknown> = {};
    if (opts.title) body.title = opts.title;
    if (opts.agent) body.agent = opts.agent;
    return this.req<{ id: string }>('/session', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { directory: opts.directory });
  }

  async deleteSession(sessionID: string, directory: string): Promise<void> {
    await this.req<unknown>(
      `/session/${encodeURIComponent(sessionID)}`,
      { method: 'DELETE' },
      { directory },
    );
  }

  async compactSession(sessionID: string, directory: string): Promise<void> {
    await this.req<unknown>(
      `/api/session/${encodeURIComponent(sessionID)}/compact`,
      { method: 'POST' },
      { directory },
    );
  }

  async sendPromptAsync(sessionID: string, directory: string, opts: PromptOpts): Promise<void> {
    const parts = buildOpenCodePromptParts(opts.text, opts.attachments);
    const body: Record<string, unknown> = {
      model: { providerID: opts.model.providerID, modelID: opts.model.modelID },
      parts,
    };
    if (opts.messageID) body.messageID = opts.messageID;
    if (opts.agent) body.agent = opts.agent;
    if (opts.variant) body.variant = opts.variant;
    if (opts.system) body.system = opts.system;
    await this.req<unknown>(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { directory });
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
  async getMessages(sessionID: string, directory: string): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    return this.req<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>(
      `/session/${encodeURIComponent(sessionID)}/message`,
      {},
      { directory },
    );
  }

  async abortSession(sessionID: string, directory: string): Promise<void> {
    try {
      await this.req<unknown>(
        `/session/${encodeURIComponent(sessionID)}/abort`,
        { method: 'POST' },
        { directory },
      );
    } catch (err) {
      // Aborting a session that's already idle returns 400 — tolerate it.
      console.debug('[openCode:server] abort returned error (probably already idle)', err);
    }
  }

  async replyPermission(
    requestID: string,
    directory: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void> {
    await this.req<unknown>(`/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        reply,
        ...(message ? { message } : {}),
      }),
    }, { directory });
  }

  async getHealth(): Promise<{ healthy: boolean; version: string }> {
    return this.req<{ healthy: boolean; version: string }>('/global/health');
  }

  async listProviders(directory: string): Promise<{
    all: OpenCodeProviderInfo[];
    default: Record<string, string>;
    connected: string[];
  }> {
    return this.req<{
      all: OpenCodeProviderInfo[];
      default: Record<string, string>;
      connected: string[];
    }>('/provider', {}, { directory });
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
    if (!proc || proc.killed || proc.exitCode !== null) {
      this.proc = null;
      this.port = null;
      this.startPromise = null;
      this.listeners.clear();
      this.globalListeners.clear();
      return;
    }

    // Polite HTTP dispose first (may quietly fail if server already gone).
    try { await this.req<unknown>('/global/dispose', { method: 'POST' }).catch(() => {}); }
    catch { /* ignore */ }
    this.proc = null;
    this.port = null;
    this.startPromise = null;
    this.listeners.clear();
    this.globalListeners.clear();
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
