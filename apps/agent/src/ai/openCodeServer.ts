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
import { getOpenCodeEnableExa } from '../config.js';
import {
  DISPLAY_MARKDOWN_REPORT_TOOL,
  QUICKSAVE_GUARDIAN_BYPASS_TOOLS,
  QUICKSAVE_MCP_PREFIX,
  UPDATE_SESSION_STATUS_TOOL,
  buildQuicksaveToolsMcpServerConfig,
} from './quicksaveToolsMcp.js';

const __aiDir = dirname(fileURLToPath(import.meta.url));

/**
 * OpenCode exposes MCP tools as `<server>_<tool>`. This deliberately ends in
 * one underscore so its separator produces the canonical Quicksave tool name:
 * `mcp__quicksave-tools__UpdateSessionStatus`.
 */
export const OPENCODE_QUICKSAVE_MCP_NAME = QUICKSAVE_MCP_PREFIX.slice(0, -1);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse the JSONC accepted by OPENCODE_CONFIG_CONTENT without executing it. */
export function parseOpenCodeConfigContent(content: string): Record<string, unknown> {
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
  enableExa = false,
): Record<string, unknown> {
  const existing = existingContent?.trim()
    ? parseOpenCodeConfigContent(existingContent)
    : {};
  const mcp = buildQuicksaveToolsMcpServerConfig({
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
      [OPENCODE_QUICKSAVE_MCP_NAME]: {
        type: 'local',
        command: [mcp.command, ...mcp.args],
        enabled: true,
        timeout: 130_000,
      },
    },
    permission: {
      ...existingPermission,
      [UPDATE_SESSION_STATUS_TOOL]: 'allow',
      [DISPLAY_MARKDOWN_REPORT_TOOL]: 'allow',
      // A question is its own user-input interaction, not an action that
      // needs a second approval. Let OpenCode emit `question.asked`, which
      // the provider translates into Quicksave's blocking question UI.
      question: 'allow',
      ...(enableExa ? { websearch: 'ask' } : {}),
    },
  };
}

/** Explicitly safe permission categories that bypass Guardian review.
 *
 * OpenCode evaluates rules in order and the last match wins. The auto-review
 * ruleset therefore starts with a catch-all `ask` and appends this allowlist.
 * New permission categories introduced by OpenCode are reviewed by default
 * instead of silently inheriting a permissive global configuration.
 * `external_directory` remains reviewed even when the underlying operation is
 * a read, because OpenCode combines all applicable resource checks. */
export const AUTO_REVIEW_SAFE_PERMISSION_ALLOWLIST = [
  'read',
  'grep',
  'glob',
  'list',
  'lsp',
  'todowrite',
  'question',
  'doom_loop',
] as const;

export function buildAutoReviewPermissionRuleset(): OpenCodePermissionRule[] {
  return [
    { permission: '*', pattern: '*', action: 'ask' },
    ...AUTO_REVIEW_SAFE_PERMISSION_ALLOWLIST.map((permission) => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
    ...QUICKSAVE_GUARDIAN_BYPASS_TOOLS.map((permission) => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
  ];
}

export function buildOpenCodeServerEnv(
  env: NodeJS.ProcessEnv = process.env,
  ownDir = __aiDir,
  enableExa = getOpenCodeEnableExa(),
): NodeJS.ProcessEnv {
  // Do not inherit an unrelated shell's opt-in: this per-agent setting is
  // authoritative and must be able to turn Exa off as well as on.
  const { OPENCODE_ENABLE_EXA: _ignoredExa, ...baseEnv } = env;
  return {
    ...baseEnv,
    ...(enableExa ? { OPENCODE_ENABLE_EXA: '1' } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      buildOpenCodeQuicksaveConfig(env.OPENCODE_CONFIG_CONTENT, ownDir, enableExa),
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
  model?: { providerID: string; modelID: string };
  metadata?: Record<string, unknown>;
  /** Per-session permission ruleset. Session rules are evaluated AFTER the
   * config-level permission map (last match wins), so they can tighten —
   * but not loosen — rules the user set globally. */
  permission?: OpenCodePermissionRule[];
}

/** One entry of an OpenCode per-session permission ruleset. */
export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

export interface OpenCodeSessionInfo {
  id: string;
  /** Set by OpenCode when this session belongs to an agent/task sub-thread. */
  parentID?: string | null;
  title?: string;
  directory?: string;
  metadata?: Record<string, unknown>;
  model?: { id: string; providerID: string; variant?: string };
  time?: { created?: number; updated?: number; archived?: number | null };
}

const DEFAULT_OPENCODE_COMPACT_TIMEOUT_MS = 600_000;

/** Client-side ceiling for the summarize POST. OpenCode has no server-side
 * timeout: on a busy session it queues until the turn ends, so without a
 * client timeout the request would hang until undici's headers timeout
 * (~5 min) and the failure would surface as an opaque fetch error.
 * Slow local models (e.g. vLLM) may need well over 3 min to summarize a
 * large session, so this is tunable via
 * QUICKSAVE_OPENCODE_COMPACT_TIMEOUT_MS (milliseconds). The PWA /compact
 * RPC timeout must be at least this value or the client gives up first. */
export function getOpenCodeCompactTimeoutMs(): number {
  const raw = Number(process.env.QUICKSAVE_OPENCODE_COMPACT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_OPENCODE_COMPACT_TIMEOUT_MS;
}

export interface PromptOpts {
  messageID?: string;
  text: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
  attachments?: readonly Attachment[];
  /** Per-prompt tool gate. OpenCode converts this into session-level
   * permission rules (`true` → allow, `false` → deny, pattern `*`), so
   * `tools: { "*": false }` disables every tool for this prompt. */
  tools?: Record<string, boolean>;
  /** Force the model's final answer to match a JSON schema (OpenCode injects
   * a StructuredOutput tool for this). */
  format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number };
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename?: string; url: string };

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
  models: Record<string, { id?: string; name?: string }>;
}

/** The v2 API exposes projected messages and opaque page cursors. */
export interface OpenCodeV2Message {
  id: string;
  type: string;
  /** Creation time in epoch ms. Set when the message was adapted from the
   *  legacy v1 route (which pages oldest-first, unlike the v2 contract). */
  createdAt?: number;
  text?: string;
  content?: Array<Record<string, unknown>>;
  command?: string;
  output?: string;
  summary?: string;
  recent?: string;
}

export interface OpenCodeV2MessagePage {
  /** Current v2 API field (OpenCode 1.18+). */
  items: OpenCodeV2Message[];
  cursor: { previous?: string; next?: string };
}

/** Normalize the message-page shapes emitted by OpenCode server revisions.
 *
 * The v2 SDK documents `{ items, cursor }`, while some installed builds have
 * returned `{ data, cursor }` or nested the page under `items`. Keep this
 * compatibility boundary here so the provider never spreads a non-array.
 */
export function normalizeOpenCodeMessagePage(value: unknown): OpenCodeV2MessagePage {
  if (Array.isArray(value)) return { items: value as OpenCodeV2Message[], cursor: {} };
  if (!isRecord(value)) return { items: [], cursor: {} };

  const nested = isRecord(value.items) ? value.items : undefined;
  const rawItems = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.data)
      ? value.data
      : nested && (Array.isArray(nested.items) || Array.isArray(nested.data))
        ? (nested.items ?? nested.data)
        : [];
  const rawCursor = isRecord(value.cursor)
    ? value.cursor
    : nested && isRecord(nested.cursor)
      ? nested.cursor
      : {};
  return {
    items: rawItems as OpenCodeV2Message[],
    cursor: {
      ...(typeof rawCursor.previous === 'string' ? { previous: rawCursor.previous } : {}),
      ...(typeof rawCursor.next === 'string' ? { next: rawCursor.next } : {}),
    },
  };
}

export interface OpenCodeLegacyMessagePage {
  data: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  nextCursor?: string;
}

function v2ToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (isRecord(item) && typeof item.text === 'string') return item.text;
      try { return JSON.stringify(item); } catch { return String(item); }
    }).join('\n');
  }
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Adapt the working v1 message response to the projected v2 shape. */
function legacyMessagesToV2(messages: OpenCodeLegacyMessagePage['data']): OpenCodeV2Message[] {
  return messages.map((message) => {
    const info = message.info;
    const id = typeof info.id === 'string' ? info.id : `legacy-${Date.now()}`;
    const time = isRecord(info.time) ? info.time.created : undefined;
    const createdAt = typeof time === 'number' ? time : undefined;
    const created = createdAt !== undefined ? { createdAt } : {};
    if (info.role === 'user') {
      return {
        id,
        type: 'user',
        ...created,
        text: message.parts
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join(''),
      };
    }
    const content: Array<Record<string, unknown>> = message.parts.flatMap((part, index): Array<Record<string, unknown>> => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return [{ type: 'text', text: part.text }];
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        return [{ type: 'reasoning', id: String(part.id ?? `${id}:reasoning:${index}`), text: part.text }];
      }
      if (part.type !== 'tool') return [];
      const state = isRecord(part.state) ? part.state : {};
      return [{
        type: 'tool',
        id: String(part.callID ?? part.id ?? `${id}:tool:${index}`),
        name: String(part.tool ?? 'unknown'),
        state: { ...state, content: state.content ?? state.output ?? [] },
      }];
    });
    return { id, type: 'assistant', ...created, content };
  });
}

/** Adapter for the current streaming router, which still consumes v1-shaped parts. */
function toLegacyMessage(message: OpenCodeV2Message): { info: Record<string, unknown>; parts: Array<Record<string, unknown>> } {
  if (message.type === 'user') {
    return {
      info: { id: message.id, role: 'user' },
      parts: typeof message.text === 'string'
        ? [{ id: `${message.id}:text`, messageID: message.id, type: 'text', text: message.text }]
        : [],
    };
  }
  if (message.type !== 'assistant') return { info: { id: message.id, role: 'system' }, parts: [] };
  const parts = (message.content ?? []).map((content) => {
    if (content.type === 'tool') {
      const state = isRecord(content.state) ? content.state : {};
      return {
        id: typeof content.id === 'string' ? content.id : `${message.id}:tool`,
        messageID: message.id,
        type: 'tool',
        tool: typeof content.name === 'string' ? content.name : 'unknown',
        callID: typeof content.id === 'string' ? content.id : `${message.id}:tool`,
        state: {
          ...state,
          output: v2ToolOutput(state.content),
          error: isRecord(state.error) ? String(state.error.message ?? 'tool failed') : state.error,
        },
      };
    }
    return { ...content, messageID: message.id };
  });
  return { info: { id: message.id, role: 'assistant' }, parts };
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

/** V2 prompt admission uses a different wire format from the legacy parts API.
 * Keep this explicit: posting to V2 does not migrate a V1 conversation. */
export function buildOpenCodeV2PromptInput(
  text: string,
  attachments: readonly Attachment[] = [],
): { text: string; files?: Array<{ uri: string; name: string }> } {
  return {
    text,
    ...(attachments.length > 0 ? {
      files: attachments.map((attachment) => ({
        uri: `data:${attachment.mimeType};base64,${attachment.data}`,
        name: attachment.name,
      })),
    } : {}),
  };
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
  private legacyHistoryProtocol: Promise<boolean> | null = null;

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

  /** Match OpenCode's own compatibility probe: a healthy legacy endpoint
   * means this 1.x server's v2 message projection cannot be relied on. */
  async usesLegacyHistoryProtocol(): Promise<boolean> {
    if (!this.legacyHistoryProtocol) {
      this.legacyHistoryProtocol = (async () => {
        const { baseUrl } = await this.ensureRunning();
        try {
          const response = await fetch(new URL('/global/health', baseUrl), {
            headers: this.requestHeaders(false),
          });
          if (!response.ok) return false;
          const value: unknown = await response.json();
          return !!value && typeof value === 'object'
            && 'healthy' in value && (value as { healthy?: unknown }).healthy === true;
        } catch {
          return false;
        }
      })();
    }
    return this.legacyHistoryProtocol;
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
    if (opts.model) body.model = { providerID: opts.model.providerID, id: opts.model.modelID };
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.permission?.length) body.permission = opts.permission;
    return this.req<{ id: string }>('/session', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { directory: opts.directory });
  }

  /** Replace the session's per-session permission ruleset. Used to apply the
   * guardian boundary to sessions created before auto-review was switched on
   * (or cold-resumed into it). */
  async setSessionPermission(
    sessionID: string,
    directory: string,
    permission: OpenCodePermissionRule[],
  ): Promise<void> {
    await this.req<unknown>(
      `/session/${encodeURIComponent(sessionID)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ permission }),
      },
      { directory },
    );
  }

  async deleteSession(sessionID: string, directory: string): Promise<void> {
    await this.req<unknown>(
      `/session/${encodeURIComponent(sessionID)}`,
      { method: 'DELETE' },
      { directory },
    );
  }

  /** OpenCode owns archive state in `session.time.archived`. */
  async setSessionArchived(sessionID: string, directory: string, archived: boolean): Promise<void> {
    await this.req<OpenCodeSessionInfo>(
      `/session/${encodeURIComponent(sessionID)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ time: { archived: archived ? Date.now() : null } }),
      },
      { directory },
    );
  }

  async getSession(sessionID: string, directory?: string): Promise<OpenCodeSessionInfo> {
    return this.req<OpenCodeSessionInfo>(
      `/session/${encodeURIComponent(sessionID)}`,
      {},
      { directory },
    );
  }

  async listSessions(directory?: string): Promise<OpenCodeSessionInfo[]> {
    return this.req<OpenCodeSessionInfo[]>('/session', {}, { directory });
  }

  /** Compact a session conversation (summary + prune) via opencode's v1
   *  `POST /session/{id}/summarize`. The v2 `POST /api/session/{id}/compact`
   *  endpoint is a server-side stub that always returns 503 "Session compact
   *  is not available yet" (see V2Session.compact in the opencode server). */
  async compactSession(
    sessionID: string,
    directory: string,
    model: { providerID: string; modelID: string },
  ): Promise<void> {
    const timeoutMs = getOpenCodeCompactTimeoutMs();
    try {
      await this.req<unknown>(
        `/session/${encodeURIComponent(sessionID)}/summarize`,
        {
          method: 'POST',
          body: JSON.stringify({
            providerID: model.providerID,
            modelID: model.modelID,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
        { directory },
      );
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') {
        throw new Error(
          `opencode compact timed out after ${timeoutMs / 1000}s — the session may still be busy or the model too slow; try again`,
        );
      }
      throw err;
    }
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
    if (opts.tools) body.tools = opts.tools;
    if (opts.format) body.format = opts.format;
    await this.req<unknown>(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { directory });
  }

  /** Admit a message to an existing V2-native session. Never use this as a
   * transparent fallback for a legacy session: V1 messages are absent from
   * the V2 runner's history, so doing so would silently lose context. */
  async sendV2Prompt(
    sessionID: string,
    opts: { text: string; attachments?: readonly Attachment[]; delivery: 'queue' | 'steer' },
  ): Promise<{ id: string; admittedSeq: number }> {
    const response = await this.req<{ data: { id: string; admittedSeq: number } }>(
      `/api/session/${encodeURIComponent(sessionID)}/prompt`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: buildOpenCodeV2PromptInput(opts.text, opts.attachments),
          delivery: opts.delivery,
          resume: true,
        }),
      },
    );
    return response.data;
  }

  /** Fetch a cursor page from OpenCode's v2 projected-message API.
   *
   * This is deliberately v2-only. The legacy `/session/.../message` route
   * cannot provide reliable cursor paging for a long session.
   */
  async getMessagePage(
    sessionID: string,
    opts: { limit: number; cursor?: string; order?: 'asc' | 'desc'; directory?: string },
  ): Promise<OpenCodeV2MessagePage> {
    const response = await this.req<unknown>(
      `/api/session/${encodeURIComponent(sessionID)}/message`,
      {},
      { limit: opts.limit, ...(opts.cursor ? { cursor: opts.cursor } : { order: opts.order ?? 'desc' }) },
    );
    const page = normalizeOpenCodeMessagePage(response);
    // OpenCode 1.18.x can expose the v2 route while returning an empty page
    // for sessions stored in legacy message tables. The legacy route still
    // returns those messages, so use it as a compatibility fallback.
    if (page.items.length === 0 && opts.directory) {
      const legacy = await this.getLegacyMessagePage(sessionID, opts.directory, opts.cursor);
      return {
        items: legacyMessagesToV2(legacy.data),
        cursor: legacy.nextCursor ? { next: legacy.nextCursor } : {},
      };
    }
    return page;
  }

  /** Legacy v1 history is cursor-paged with x-next-cursor. Kept solely to
   * recover Quicksave's own card cache for a v1 server. */
  async getLegacyMessagePage(sessionID: string, directory: string, before?: string): Promise<OpenCodeLegacyMessagePage> {
    const { baseUrl } = await this.ensureRunning();
    const url = buildOpenCodeUrl(baseUrl, `/session/${encodeURIComponent(sessionID)}/message`, {
      directory,
      limit: 200,
      ...(before ? { before } : {}),
    });
    const response = await fetch(url, { headers: this.requestHeaders(false) });
    if (!response.ok) throw new Error(`opencode legacy history failed: ${response.status}`);
    const data = await response.json() as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    return { data, ...(response.headers.get('x-next-cursor') ? { nextCursor: response.headers.get('x-next-cursor')! } : {}) };
  }

  /** Fetch the latest v2 message page and adapt it for the live SSE router.
   *
   * Tool calls in opencode 1.14 are NOT pushed via SSE — only `message.part.delta`
   * (text/reasoning), `session.status`, `session.diff`, and `session.idle` ever
   * appear on `/event`. The authoritative list of tool parts (with `input`,
   * `output`, `state.status`) lives only on `GET /session/{id}/message`.
   *
   * Shape:
   *   [{ info: { id, role, ... }, parts: [{ type: 'tool'|'text'|..., ... }] }]
   */
  async getMessages(sessionID: string, _directory: string): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    const page = await this.getMessagePage(sessionID, { limit: 200, order: 'desc', directory: _directory });
    return page.items.map(toLegacyMessage);
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

  /** Resolve OpenCode's blocking `question` tool with one answer array per
   * question. Each inner array contains the selected labels (or one custom
   * free-text response). */
  async replyQuestion(
    requestID: string,
    directory: string,
    answers: readonly (readonly string[])[],
  ): Promise<void> {
    await this.req<unknown>(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }, { directory });
  }

  /** Dismiss OpenCode's blocking `question` tool without supplying answers. */
  async rejectQuestion(requestID: string, directory: string): Promise<void> {
    await this.req<unknown>(`/question/${encodeURIComponent(requestID)}/reject`, {
      method: 'POST',
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

  /** Read-only configuration endpoints. The caller is responsible for
   * reducing these raw server payloads to a safe PWA-facing snapshot. */
  async getConfig(directory: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('/config', {}, { directory });
  }

  async listMcp(directory: string): Promise<Record<string, Record<string, unknown>>> {
    return this.req<Record<string, Record<string, unknown>>>('/mcp', {}, { directory });
  }

  async addMcp(name: string, config: Record<string, unknown>, directory: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('/mcp', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    }, { directory });
  }

  async listAgents(directory: string): Promise<Array<Record<string, unknown>>> {
    return this.req<Array<Record<string, unknown>>>('/agent', {}, { directory });
  }

  async listCommands(directory: string): Promise<Array<Record<string, unknown>>> {
    return this.req<Array<Record<string, unknown>>>('/command', {}, { directory });
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

  /** Restart only the OpenCode child after a server-start environment change.
   * Active OpenCode turns cannot survive this boundary, so notify their
   * consumers just as an unexpected child exit would. */
  async restart(): Promise<void> {
    const hadServer = !!this.proc || !!this.port;
    if (hadServer) {
      this.broadcast({
        id: `local-${Date.now()}`,
        type: 'server.disposed',
        properties: {},
      });
    }
    await this.shutdown();
    this.shuttingDown = false;
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
