// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// OpenCode HTTP-server provider.
//
// Earlier revisions of this file drove the `opencode run --format json` CLI
// per turn. That works once but is single-shot — there's no way to resume the
// same conversation, the CLI hangs on open stdin pipes, and the process spin
// up cost (~3s) hits every prompt. We now talk to a single long-lived
// `opencode serve` instance over HTTP + SSE; see `openCodeServer.ts` for the
// shared lifecycle.
//
// Event → Card translation (verified against opencode 1.14 and 1.18):
//   • `message.part.updated` is the source of truth for each part. We use it
//     in preference to `message.part.delta` so the implementation is
//     idempotent and easy to test (Card emission per Part snapshot, not per
//     delta byte). Each Part type maps as:
//       - TextPart      → assistantText + finalize
//       - ReasoningPart → thinkingBlock
//       - ToolPart      → toolUse / toolResult (depending on state.status)
//     Step / file / patch / snapshot parts are ignored — they have no card.
//   • `session.status { type: "idle" }` is the current end-of-turn signal;
//     `session.idle` remains supported for older OpenCode releases.
//   • `session.error` becomes a visible `[opencode error]` card and a failed
//     `streamEnd`.
//   • `permission.asked` is forwarded to the PWA via the usual
//     `handlePermissionRequest` callback; the reply is POSTed back to
//     `/permission/{id}/reply`.

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Attachment, Card, CardHistoryResponse, CardStreamEnd, ContextUsageBreakdown, NativeSessionSummary } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  StartSessionOpts,
  ResumeSessionOpts,
  ProbeResult,
  PermissionLevel,
} from './provider.js';
import { getOpenCodeServer, type OpenCodeEvent, type OpenCodeServer, type OpenCodeV2Message } from './openCodeServer.js';
import { QUICKSAVE_SESSION_ID_ARG } from './openCodeMcpPlugin.js';

// ── Part types we translate (verified from opencode 1.14 OpenAPI Part union) ──

interface BasePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
}

interface TextPart extends BasePart {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

interface ReasoningPart extends BasePart {
  type: 'reasoning';
  text: string;
}

type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

interface ToolPart extends BasePart {
  type: 'tool';
  tool: string;
  callID: string;
  state: {
    status: ToolStatus;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    title?: string;
    time?: { start: number; end?: number };
  };
}

interface StepFinishPart extends BasePart {
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

type AnyPart = TextPart | ReasoningPart | ToolPart | StepFinishPart | BasePart;

// ── Model id validation ──────────────────────────────────────────────────────
//
// opencode's HTTP API takes `{ providerID, modelID }` as a structured object,
// not the slashed `provider/model` form the CLI accepted. We keep accepting
// the slashed form from quicksave callers (so existing prefs keep working)
// and split it on the first `/`. Anything without a slash is invalid; the
// server has no concept of a default fallback per request — the provider
// must be named explicitly — so we surface the failure up-front rather than
// silently sending nothing.
const OPENCODE_MODEL_RE = /^[^/\s]+\/[^\s]+$/;

export function isValidOpenCodeModelId(model: string | undefined | null): model is string {
  return typeof model === 'string' && OPENCODE_MODEL_RE.test(model);
}

export function parseModelId(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf('/');
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

// OpenCode exposes lowercase tool IDs and uses camelCase for several argument
// names. Quicksave's card registry follows the Claude-style canonical names
// and snake_case file-edit inputs, so normalize at the provider boundary.
const OPENCODE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  skill: 'Skill',
  task: 'Agent',
  todowrite: 'TodoWrite',
  todoread: 'TodoWrite',
  question: 'AskUserQuestion',
  lsp: 'LSP',
  apply_patch: 'ApplyPatch',
  plan: 'ExitPlanMode',
  external_directory: 'ExternalDirectory',
};

export function normalizeOpenCodeToolName(toolName: string): string {
  return OPENCODE_TOOL_NAMES[toolName] ?? toolName;
}

export function normalizeOpenCodeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...input };
  // OpenCode's host hook adds this only to route workspace-scoped MCP calls
  // to the correct Quicksave session. It is transport metadata, not card data.
  delete normalized[QUICKSAVE_SESSION_ID_ARG];
  const aliases: Array<[string, string]> = [
    ['filePath', 'file_path'],
    ['oldString', 'old_string'],
    ['newString', 'new_string'],
    ['replaceAll', 'replace_all'],
    ['patchText', 'patch_text'],
  ];
  for (const [from, to] of aliases) {
    if (normalized[to] === undefined && normalized[from] !== undefined) {
      normalized[to] = normalized[from];
    }
  }
  if (toolName === 'skill' && normalized.skill === undefined && normalized.name !== undefined) {
    normalized.skill = normalized.name;
  }
  return normalized;
}

function firstTaskString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

// ── Binary resolution (still needed for the `opencode models` probe + serve spawn) ──

let _opencodeBin: string | undefined;
export function _resetOpenCodeBinCache(): void { _opencodeBin = undefined; }

export function getOpenCodeBin(): string {
  if (_opencodeBin) return _opencodeBin;
  try {
    const resolved = execSync('which opencode', { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (resolved) { _opencodeBin = resolved; return _opencodeBin; }
  } catch { /* not in PATH */ }
  const home = process.env.HOME ?? '';
  const candidates = [
    join(home, '.nvm', 'versions', 'node', 'bin', 'opencode'),
    join(home, '.npm-global', 'bin', 'opencode'),
    join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ];
  try {
    const nvmDir = join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmDir)) {
      for (const ver of readdirSync(nvmDir)) {
        candidates.push(join(nvmDir, ver, 'bin', 'opencode'));
      }
    }
  } catch { /* ignore */ }
  for (const c of candidates) if (existsSync(c)) { _opencodeBin = c; return _opencodeBin; }
  _opencodeBin = 'opencode';
  return _opencodeBin;
}

// ── Session wrapper ──────────────────────────────────────────────────────────

export interface TurnConfig {
  model: { providerID: string; modelID: string };
  variant?: string;
  system?: string;
}

export class OpencodeSession implements ProviderSession {
  /** opencode server's `ses_…` id. Stable across turns; we use it for
    *  follow-up prompts and abort. */
  readonly opencodeSessionId: string;
  private server: OpenCodeServer;
  private router: SessionEventRouter | null = null;
  private dispose: () => void = () => {};
  private aliveFlag = true;
  private readonly directory: string;
  private turnConfig: TurnConfig;
  private cb: StreamCardBuilder | null = null;
  private callbacks: ProviderCallbacks | null = null;
  /** Model context window for building ContextUsageBreakdown. */
  private modelContextWindow: number | undefined;

  constructor(
    opencodeSessionId: string,
    server: OpenCodeServer,
    directory: string,
    turnConfig: TurnConfig,
    modelContextWindow?: number,
  ) {
    this.opencodeSessionId = opencodeSessionId;
    this.server = server;
    this.directory = directory;
    this.turnConfig = turnConfig;
    this.modelContextWindow = modelContextWindow;
  }

  /** @internal wires the per-session SSE consumer state for follow-ups. */
  _setTurnWiring(
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    router: SessionEventRouter,
    dispose: () => void,
  ) {
    this.cb = cb;
    this.callbacks = callbacks;
    this.router = router;
    this.dispose = dispose;
  }

  /** Hot resume entry: SessionManager calls this for in-process follow-ups.
   *  Kicks off a new turn against the same opencode session. */
  sendUserMessage(prompt: string, attachments?: readonly Attachment[]): void {
    if (!this.aliveFlag || !this.cb || !this.callbacks || !this.router) {
      console.warn('[openCode] sendUserMessage on a dead session — ignoring');
      return;
    }
    // Emit the user card immediately so the PWA reflects the prompt without
    // waiting for SSE round-trip.
    if (prompt || (attachments && attachments.length > 0)) {
      this.callbacks.emitCardEvent(this.cb.userMessage(prompt, attachments));
    }
    this.cb.startNewTurn();
    this.router.resetForNewTurn();
    this.server.sendPromptAsync(this.opencodeSessionId, this.directory, {
      text: prompt,
      attachments,
      model: this.turnConfig.model,
      ...(this.turnConfig.variant ? { variant: this.turnConfig.variant } : {}),
      ...(this.turnConfig.system ? { system: this.turnConfig.system } : {}),
    }).catch((err: Error) => {
      console.error('[openCode] follow-up prompt_async failed:', err);
      this.router?.finalize(false, err.message);
    });
  }

  interrupt(): void {
    void this.server.abortSession(this.opencodeSessionId, this.directory).catch(() => {});
  }

  kill(): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    void this.server.abortSession(this.opencodeSessionId, this.directory).catch(() => {});
    this.dispose();
  }

  setPermissionMode(level: PermissionLevel): void {
    this.router?.setPermissionLevel(level);
  }

  get alive(): boolean { return this.aliveFlag; }

  async getContextUsage(): Promise<ContextUsageBreakdown | null> {
    if (!this.router) return null;
    const totals = this.router.getTurnTokenTotals();
    if (!totals.inputTokens && !totals.outputTokens) return null;
    const modelContextWindow = this.modelContextWindow ?? totals.modelContextWindow;
    if (!modelContextWindow || modelContextWindow <= 0) return null;
    const totalTokens = totals.inputTokens;
    return {
      categories: [
        { name: 'OpenCode input', tokens: totals.inputTokens, color: 'claude' },
      ],
      totalTokens,
      maxTokens: modelContextWindow,
      rawMaxTokens: modelContextWindow,
      autocompactSource: 'opencode-last-turn-input',
      percentage: (totalTokens / modelContextWindow) * 100,
      model: this.turnConfig.model?.modelID,
    };
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class OpenCodeProvider implements CodingAgentProvider {
  readonly id = 'opencode' as const;
  readonly historyMode = 'opencode-thread' as const;
  readonly archiveStorage = 'native' as const;
  readonly label = 'OpenCode';

  constructor(private readonly server: OpenCodeServer = getOpenCodeServer()) {}

  async probeProvider(): Promise<ProbeResult> {
    const hasCli = this.isCliAvailable();
    const capabilities: ProbeResult['capabilities'] = {
      hasApiKey: !!process.env.OPENCODE_API_KEY || !!process.env.OPENAI_API_KEY,
      hasCli,
      hasPlugin: false,
      // We DO support resume now (HTTP-server keeps session alive across turns).
      supportsResume: true,
      supportsSandbox: false,
      supportsStreaming: true,
      supportsAttachments: true,
      supportedAttachmentKinds: ['image', 'pdf', 'text'],
    };
    if (!hasCli) return { capabilities, models: [] };
    try {
      const [health, providerResult] = await Promise.all([
        this.server.getHealth(),
        this.server.listProviders(process.cwd()),
      ]);
      const connected = new Set(providerResult.connected ?? []);
      const models = providerResult.all.flatMap((provider) => {
        if (!connected.has(provider.id)) return [];
        return Object.entries(provider.models ?? {}).map(([modelKey, model]) => {
          const modelID = model.id || modelKey;
          const id = `${provider.id}/${modelID}`;
          return { id, name: model.name || id, providerId: provider.id, providerName: provider.name };
        });
      });
      return { version: health.version, capabilities, models };
    } catch (err) {
      console.warn('[openCode] failed to query server health/providers:', err);
      return { version: this.getCliVersion(), capabilities, models: [] };
    }
  }

  private isCliAvailable(): boolean {
    return this.getCliVersion() !== undefined;
  }

  private getCliVersion(): string | undefined {
    try {
      const bin = getOpenCodeBin();
      return execSync(`"${bin}" --version`, { timeout: 3_000, encoding: 'utf-8' }).trim();
    } catch { return undefined; }
  }

  /** Fail early on installations that lack the v2 cursor-history contract. */
  private async requireV2History(sessionId: string): Promise<void> {
    await this.server.getMessagePage(sessionId, { limit: 1, order: 'desc' });
  }

  /** Read cards from OpenCode's v2 cursor API; never from Quicksave card storage. */
  async loadCardHistory(opts: {
    sessionId: string;
    cwd: string;
    offset: number;
    limit: number;
    cursor?: string;
  }): Promise<CardHistoryResponse> {
    const nativeCursor = opts.cursor?.startsWith('opencode-v2:')
      ? opts.cursor.slice('opencode-v2:'.length)
      : undefined;
    const page = await this.server.getMessagePage(opts.sessionId, {
      limit: Math.min(200, Math.max(1, opts.limit)),
      ...(nativeCursor ? { cursor: nativeCursor } : { order: 'desc' }),
    });
    // v2 returns descending pages by default; cards must remain chronological.
    const cards = projectOpenCodeMessages(opts.sessionId, opts.cwd, [...page.data].reverse());
    return {
      cards,
      // v2 intentionally provides no total count. This is a lower bound; the
      // PWA uses the opaque cursor/hasMore contract for further history.
      total: opts.offset + cards.length + (page.cursor.next ? 1 : 0),
      hasMore: !!page.cursor.next,
      ...(page.cursor.next ? { nextCursor: `opencode-v2:${page.cursor.next}` } : {}),
    };
  }

  async listNativeSessions(opts?: { cwd?: string }): Promise<NativeSessionSummary[]> {
    const sessions = await this.server.listSessions(opts?.cwd);
    return sessions
      .filter((session) => !opts?.cwd || session.directory === opts.cwd)
      .map((session) => ({
        sessionId: session.id,
        cwd: session.directory ?? opts?.cwd ?? process.cwd(),
        agent: 'opencode' as const,
        archived: session.time?.archived != null,
        title: session.title,
        firstPrompt: session.title,
        createdAt: session.time?.created ?? session.time?.updated ?? 0,
        lastInteractionAt: session.time?.updated ?? session.time?.created ?? 0,
      }));
  }

  async archiveSession(sessionId: string, opts?: { cwd?: string }): Promise<void> {
    if (!opts?.cwd) throw new Error(`OpenCode archive requires the session directory (${sessionId})`);
    await this.server.setSessionArchived(sessionId, opts.cwd, true);
  }

  async unarchiveSession(sessionId: string, opts?: { cwd?: string }): Promise<void> {
    if (!opts?.cwd) throw new Error(`OpenCode unarchive requires the session directory (${sessionId})`);
    await this.server.setSessionArchived(sessionId, opts.cwd, false);
  }

  // ── startSession ────────────────────────────────────────────────────────────

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    if (!opts.model || !isValidOpenCodeModelId(opts.model)) {
      throw new Error(
        opts.model
          ? `opencode model id "${opts.model}" is invalid (must be provider/model)`
          : 'opencode requires an explicit model id (provider/model)',
      );
    }
    const server = this.server;
    const { id: opencodeSessionId } = await server.createSession({
      directory: opts.cwd,
      agent: 'build',
    });
    try {
      await this.requireV2History(opencodeSessionId);
    } catch (err) {
      await server.deleteSession(opencodeSessionId, opts.cwd).catch(() => {});
      throw new Error(`OpenCode v2 cursor history API is required: ${(err as Error).message}`);
    }

    const turnConfig: TurnConfig = {
      model: parseModelId(opts.model),
      ...(opts.reasoningEffort ? { variant: opts.reasoningEffort } : {}),
      ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    };
    const session = new OpencodeSession(opencodeSessionId, server, opts.cwd, turnConfig, opts.contextWindow);
    cardBuilder.updateSessionId(opencodeSessionId);

    if (opts.prompt || (opts.attachments && opts.attachments.length > 0)) {
      callbacks.emitCardEvent(cardBuilder.userMessage(opts.prompt, opts.attachments));
    }
    cardBuilder.startNewTurn();

    const router = new SessionEventRouter(opencodeSessionId, cardBuilder, callbacks, server, {
      directory: opts.cwd,
      permissionLevel: opts.permissionLevel,
    });
    const unsub = server.subscribe(opencodeSessionId, (ev) => router.handle(ev));
    session._setTurnWiring(cardBuilder, callbacks, router, unsub);

    // Give SessionManager one macrotask to persist the new registry entry.
    // The first UpdateSessionStatus MCP call can otherwise beat registration.
    setImmediate(() => {
      if (!session.alive) return;
      server.sendPromptAsync(opencodeSessionId, opts.cwd, {
        text: opts.prompt,
        attachments: opts.attachments,
        model: turnConfig.model,
        ...(turnConfig.variant ? { variant: turnConfig.variant } : {}),
        ...(turnConfig.system ? { system: turnConfig.system } : {}),
      }).catch((err: Error) => {
        console.error('[openCode] prompt_async failed:', err);
        router.finalize(false, err.message);
      });
    });

    return { sessionId: opencodeSessionId, session };
  }

  // ── compact ──────────────────────────────────────────────────────────────────

  /** Compact an existing opencode session using the dedicated API. */
  async compact(sessionId: string, opts?: { cwd?: string; directory?: string; model?: string }): Promise<void> {
    const directory = opts?.cwd ?? opts?.directory ?? process.cwd();
    if (!opts?.model || !isValidOpenCodeModelId(opts.model)) {
      throw new Error(
        opts?.model
          ? `opencode compact requires the session model (provider/model), got "${opts.model}"`
          : 'opencode compact requires the session model (provider/model)',
      );
    }
    await this.server.compactSession(sessionId, directory, parseModelId(opts.model));
  }

  // ── resumeSession ───────────────────────────────────────────────────────────

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    if (!opts.model || !isValidOpenCodeModelId(opts.model)) {
      throw new Error(
        opts.model
          ? `opencode model id "${opts.model}" is invalid (must be provider/model)`
          : 'opencode requires an explicit model id (provider/model)',
      );
    }
    const server = this.server;
    // `opts.sessionId` from SessionManager IS opencode's ses_… (we returned
    // it from startSession). Reuse it directly — no createSession.
    const opencodeSessionId = opts.sessionId;
    await this.requireV2History(opencodeSessionId).catch((err) => {
      throw new Error(`OpenCode v2 cursor history API is required: ${(err as Error).message}`);
    });

    const turnConfig: TurnConfig = {
      model: parseModelId(opts.model),
      ...(opts.reasoningEffort ? { variant: opts.reasoningEffort } : {}),
      ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    };
    const session = new OpencodeSession(opencodeSessionId, server, opts.cwd, turnConfig, opts.contextWindow);
    cardBuilder.updateSessionId(opencodeSessionId);

    if (opts.prompt || (opts.attachments && opts.attachments.length > 0)) {
      callbacks.emitCardEvent(cardBuilder.userMessage(opts.prompt, opts.attachments));
    }
    cardBuilder.startNewTurn();

    const router = new SessionEventRouter(opencodeSessionId, cardBuilder, callbacks, server, {
      directory: opts.cwd,
      permissionLevel: opts.permissionLevel,
    });
    // A cold resume creates a fresh router whose in-memory dedupe sets are
    // empty, while OpenCode's message endpoint returns the entire session.
    // Prime those sets before starting the new turn so the first REST tool
    // sync does not replay every historical tool call into the chat.
    await router.primeHistoricalState().catch((err) => {
      console.warn('[openCode] failed to prime resume history:', err);
    });
    const unsub = server.subscribe(opencodeSessionId, (ev) => router.handle(ev));
    session._setTurnWiring(cardBuilder, callbacks, router, unsub);

    server.sendPromptAsync(opencodeSessionId, opts.cwd, {
      text: opts.prompt,
      attachments: opts.attachments,
      model: turnConfig.model,
      ...(turnConfig.variant ? { variant: turnConfig.variant } : {}),
      ...(turnConfig.system ? { system: turnConfig.system } : {}),
    }).catch((err: Error) => {
      console.error('[openCode] resume prompt_async failed:', err);
      router.finalize(false, err.message);
    });

    return { sessionId: opencodeSessionId, session };
  }
}

function v2ContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v2ContentText).filter(Boolean).join('\n');
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Stable final-state projection of one OpenCode v2 message page. */
export function projectOpenCodeMessages(sessionId: string, cwd: string, messages: readonly OpenCodeV2Message[]): Card[] {
  const builder = new StreamCardBuilder(sessionId, cwd);
  for (const message of messages) {
    builder.startNewTurn(message.id);
    switch (message.type) {
      case 'user':
        if (message.text) builder.userMessage(message.text);
        break;
      case 'assistant':
        for (const content of message.content ?? []) {
          if (content.type === 'text' && typeof content.text === 'string') {
            builder.assistantText(content.text);
            builder.finalizeAssistantText();
            continue;
          }
          if (content.type === 'reasoning' && typeof content.text === 'string') {
            builder.thinkingBlock(content.text);
            continue;
          }
          if (content.type !== 'tool') continue;
          const id = typeof content.id === 'string' ? content.id : `${message.id}:tool`;
          const state = content.state && typeof content.state === 'object'
            ? content.state as Record<string, unknown>
            : {};
          const rawName = typeof content.name === 'string' ? content.name : 'unknown';
          const input = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
            ? state.input as Record<string, unknown>
            : {};
          builder.toolUse(normalizeOpenCodeToolName(rawName), normalizeOpenCodeToolInput(rawName, input), id);
          const failed = state.status === 'error';
          const output = failed
            ? v2ContentText(state.error)
            : v2ContentText(state.content);
          builder.toolResult(id, output, failed);
        }
        break;
      case 'shell':
        builder.toolUse('Bash', { command: message.command ?? '' }, message.id);
        builder.toolResult(message.id, message.output ?? '', false);
        break;
      case 'compaction':
        builder.systemMessage('Context compacted', 'compacted');
        break;
      default:
        break;
    }
    builder.markTurnCompleted(message.id);
  }
  return builder.getCards();
}

// ── SSE → CardEvent router ───────────────────────────────────────────────────

/** @internal exposed for tests; do not use outside this module. */
export class SessionEventRouter {
  private readonly sessionId: string;
  private readonly cb: StreamCardBuilder;
  private readonly callbacks: ProviderCallbacks;
  private readonly server: OpenCodeServer;
  private readonly directory: string;
  private permissionLevel: PermissionLevel;
  private finalized = false;
  /** Track which parts we've already emitted as cards so re-emits become
   *  no-ops. opencode publishes both `delta` and `updated` events for the
   *  same Part, and tool state can transition from empty pending input to a
   *  completed snapshot with final arguments. */
  private toolCards = new Map<string, string>(); // callID → latest normalized tool/input fingerprint
  private toolResults = new Set<string>(); // callIDs we've emitted toolResult for
  private textPartIds = new Map<string, string>(); // partID → emitted text (for dedupe)
  private reasoningPartIds = new Map<string, string>();
  private partKinds = new Map<string, 'text' | 'reasoning'>();
  private messageRoles = new Map<string, 'user' | 'assistant'>();
  // Per-turn token tracking from step-finish parts.
  private turnInputTokens = 0;
  private turnOutputTokens = 0;
  private turnCacheRead = 0;
  private turnCacheWrite = 0;
  private turnCost = 0;
  private turnModelContextWindow: number | undefined;

  constructor(
    sessionId: string,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    server: OpenCodeServer,
    opts: { directory?: string; permissionLevel?: PermissionLevel } = {},
  ) {
    this.sessionId = sessionId;
    this.cb = cb;
    this.callbacks = callbacks;
    this.server = server;
    this.directory = opts.directory ?? process.cwd();
    this.permissionLevel = opts.permissionLevel ?? 'default';
  }

  setPermissionLevel(level: PermissionLevel): void {
    this.permissionLevel = level;
  }

  getPermissionLevel(): PermissionLevel {
    return this.permissionLevel;
  }

  /** Seed session-wide REST dedupe state without emitting cards.
   *
   * OpenCode's message endpoint is a full-session snapshot. A newly-created
   * router on cold resume must learn which tool calls already belong to the
   * persisted history before the new prompt starts; otherwise the first
   * session.diff/text/idle sync treats every old tool part as new.
   */
  async primeHistoricalState(): Promise<void> {
    const messages = await this.server.getMessages(this.sessionId, this.directory);
    for (const msg of messages) {
      const id = msg.info?.id;
      const role = msg.info?.role;
      if (typeof id === 'string' && (role === 'user' || role === 'assistant')) {
        this.messageRoles.set(id, role);
      }
      for (const part of msg.parts) {
        if (part?.type !== 'tool') continue;
        const callID = part.callID as string | undefined;
        const rawToolName = part.tool as string | undefined;
        if (!callID || !rawToolName) continue;
        const state = (part.state ?? {}) as {
          status?: string;
          input?: Record<string, unknown>;
        };
        const toolName = normalizeOpenCodeToolName(rawToolName);
        const input = normalizeOpenCodeToolInput(rawToolName, state.input ?? {});
        this.toolCards.set(callID, JSON.stringify([toolName, input]));
        if (state.status === 'completed' || state.status === 'error') {
          this.toolResults.add(callID);
        }
      }
    }
  }

  /** Expose current turn token totals so the session can build a
    * ContextUsageBreakdown on demand. */
  getTurnTokenTotals(): {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    modelContextWindow: number | undefined;
  } {
    return {
      inputTokens: this.turnInputTokens,
      outputTokens: this.turnOutputTokens,
      cacheRead: this.turnCacheRead,
      cacheWrite: this.turnCacheWrite,
      cost: this.turnCost,
      modelContextWindow: this.turnModelContextWindow,
    };
  }

  /** Reset turn-scoped state so the next opencode turn streams into a fresh
    * set of cards. Per-session disposers and the SSE subscription stay live. */
  resetForNewTurn(): void {
    this.finalized = false;
    // Keep message/part/call dedupe state for the whole OpenCode session.
    // REST returns historical messages on every sync, so clearing these maps
    // here would replay prior-turn tools into the new turn.
    this.deltaBuf.clear();
    // Reset per-turn token counters.
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.turnCacheRead = 0;
    this.turnCacheWrite = 0;
    this.turnCost = 0;
    this.turnModelContextWindow = undefined;
  }

  handle(ev: OpenCodeEvent): void {
    if (this.finalized) return;
    switch (ev.type) {
      case 'message.updated': {
        const info = (ev.properties as {
          info?: { id?: string; role?: string };
        }).info;
        if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
          this.messageRoles.set(info.id, info.role);
        }
        break;
      }
      case 'message.part.delta':
        // Streaming text/reasoning chunks. opencode does NOT also emit a
        // terminal `message.part.updated` for these (verified empirically),
        // so the delta event IS our source of truth.
        this.handleDelta(ev.properties as { partID: string; field: string; delta: string; messageID: string });
        break;
      case 'message.part.updated':
        // Tool parts and any other structured part. opencode 1.14's SSE
        // stream does NOT actually emit this for tool parts (verified
        // empirically), so we also poll REST `/session/{id}/message` on
        // session.diff / session.idle / new text partID. Kept here in case
        // a future opencode version starts emitting it.
        this.handlePart((ev.properties as { part: AnyPart }).part);
        break;
      case 'session.diff':
        // File-mutating tools (bash with redirects, edit, write, patch)
        // emit a session.diff once they finish. Use it as an early trigger
        // to surface the tool card BEFORE the model's follow-up text streams.
        this.scheduleToolSync();
        break;
      case 'session.idle':
        this.finalize(true);
        break;
      case 'session.status': {
        const status = (ev.properties as { status?: { type?: string } }).status;
        if (status?.type === 'idle') this.finalize(true);
        break;
      }
      case 'session.error': {
        const err = (ev.properties as { error?: { data?: { message?: string }; name?: string } }).error;
        const msg = err?.data?.message || err?.name || 'opencode session error';
        this.emitErrorCard(msg);
        this.finalize(false, msg);
        break;
      }
      case 'permission.asked':
        void this.handlePermissionAsked(ev);
        break;
      case 'server.disposed':
        this.finalize(false, 'opencode server exited');
        break;
      default:
        // Many event types we don't care about (lsp.*, file.*, vcs.*,
        // session.updated metadata, server.heartbeat, etc.).
        break;
    }
  }

  /** Coalesce concurrent tool-sync requests into a single in-flight fetch.
   *  Subsequent callers wait on the same promise so the REST endpoint is
   *  hit at most once per "cycle". */
  private toolSyncPending: Promise<void> | null = null;
  private scheduleToolSync(): void {
    if (this.toolSyncPending) return;
    this.toolSyncPending = this.syncToolPartsFromRest()
      .catch((err) => { console.warn('[openCode] tool sync failed:', err); })
      .finally(() => { this.toolSyncPending = null; });
  }

  /** Wait for any in-flight tool sync to complete. Used by finalize() so
   *  the final stream-end fires AFTER all tool cards have been emitted. */
  private async waitForToolSync(): Promise<void> {
    if (this.toolSyncPending) {
      try { await this.toolSyncPending; } catch { /* logged above */ }
    }
  }

  /** Pull message parts from REST and emit cards for any tool parts we
   *  haven't seen yet. Idempotent — relies on `toolCards` / `toolResults`
   *  state keyed by callID to dedup against earlier syncs and against any
   *  future SSE-delivered `message.part.updated` events. */
  private async syncToolPartsFromRest(): Promise<void> {
    if (this.finalized) return;
    const messages = await this.server.getMessages(this.sessionId, this.directory);
    // Capture roles before handling parts. OpenCode publishes the user's
    // prompt as a normal text part too; it must not become assistant output.
    for (const msg of messages) {
      const id = msg.info?.id;
      const role = msg.info?.role;
      if (typeof id === 'string' && (role === 'user' || role === 'assistant')) {
        this.messageRoles.set(id, role);
      }
    }
    // Finalize any open text card BEFORE emitting tool cards so they
    // interleave in the correct chat order (text → tool → follow-up text).
    let flushedText = false;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part?.type !== 'tool') continue;
        const callID = part.callID as string | undefined;
        const toolName = part.tool as string | undefined;
        if (!callID || !toolName) continue;
        const state = (part.state ?? {}) as { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
        if (!this.toolCards.has(callID)) {
          if (!flushedText) {
            const fin = this.cb.finalizeAssistantText();
            if (fin) this.callbacks.emitCardEvent(fin);
            flushedText = true;
          }
        }
        this.emitToolPart(toolName, callID, state);
      }
    }
  }

  /** Incremental delta on a `text` or `reasoning` part. We accumulate per
   *  partID and emit per-card for clean bubble grouping. */
  private deltaBuf = new Map<string, { field: 'text' | 'reasoning'; text: string; cardOpen: boolean }>();

  private handleDelta(p: { partID: string; field: string; delta: string; messageID?: string }): void {
    if (!p.partID || !p.delta) return;
    if (p.field !== 'text' && p.field !== 'reasoning') return;
    if (p.messageID && this.messageRoles.get(p.messageID) === 'user') return;
    const field = this.partKinds.get(p.partID) ?? p.field;
    let state = this.deltaBuf.get(p.partID);
    if (!state) {
      state = { field, text: '', cardOpen: false };
      this.deltaBuf.set(p.partID, state);
    } else if (state.field !== field) {
      state.field = field;
    }
    state.text += p.delta;
    if (state.field === 'text') {
      // OpenCode commonly emits "\n\n" as a separator between reasoning,
      // tool calls, and visible assistant text. Keep leading whitespace
      // buffered until this part contains something Markdown can display;
      // otherwise a following tool call finalizes a blank assistant card.
      if (!state.cardOpen && !state.text.trim()) return;
      const openingCard = !state.cardOpen;
      // First chunk for this partID closes any other open text card, then
      // creates a fresh one. Subsequent chunks append to the same card via
      // assistantText() which the StreamCardBuilder coalesces.
      if (openingCard) {
        this.flushBufferedReasoning();
        const fin = this.cb.finalizeAssistantText();
        if (fin) this.callbacks.emitCardEvent(fin);
        state.cardOpen = true;
        // A new text part starting may mean a tool just completed (opencode
        // doesn't push tool parts via SSE — we poll REST). Debounced, so a
        // spurious sync at the very first text card of the turn is cheap.
        this.scheduleToolSync();
      }
      const text = openingCard ? state.text : p.delta;
      this.callbacks.emitCardEvent(this.cb.assistantText(text));
      this.textPartIds.set(p.partID, state.text);
    }
    // reasoning deltas: buffer until we see a terminator. opencode doesn't
    // emit a per-part `complete` event, so we flush reasoning on the next
    // text card OR on finalize. See flushPendingReasoning().
  }

  /** Flush buffered reasoning chunks (collected via handleDelta) into a
   *  single thinkingBlock per part. Idempotent. */
  private flushPendingReasoning(): void {
    this.flushBufferedReasoning();
    for (const [partID, state] of this.deltaBuf) {
      if (state.field === 'text' && state.cardOpen) {
        const fin = this.cb.finalizeAssistantText();
        if (fin) this.callbacks.emitCardEvent(fin);
        state.cardOpen = false;
      }
      void partID;
    }
  }

  private flushBufferedReasoning(): void {
    for (const [partID, state] of this.deltaBuf) {
      if (state.field !== 'reasoning' || !state.text) continue;
      const prev = this.reasoningPartIds.get(partID) ?? '';
      const delta = state.text.startsWith(prev) ? state.text.slice(prev.length) : state.text;
      if (delta) this.callbacks.emitCardEvent(this.cb.thinkingBlock(delta));
      this.reasoningPartIds.set(partID, state.text);
      state.text = '';
    }
  }

  private handlePart(part: AnyPart): void {
    if (!part || typeof part.type !== 'string') return;
    if (this.messageRoles.get(part.messageID) === 'user') return;
    if (part.type === 'text') {
      const tp = part as TextPart;
      this.partKinds.set(tp.id, 'text');
      if (tp.ignored || !tp.text.trim()) return;
      // We may see the same partID several times as the model streams; replay
      // only the latest snapshot, replacing whatever we showed before. The
      // CardBuilder doesn't support in-place text replace, so the practical
      // pattern is: don't emit until the part stops growing. opencode emits
      // a final `message.part.updated` once the part is done, but it also
      // emits intermediate snapshots. To avoid bubble churn we emit on the
      // FIRST snapshot we see for each partID (the assistant-text card will
      // append further chunks via assistantText() in the rare case the part
      // grows — they go to a new card so the chat looks like clean blocks).
      if (!this.textPartIds.has(tp.id)) {
        this.textPartIds.set(tp.id, tp.text);
        this.callbacks.emitCardEvent(this.cb.assistantText(tp.text));
        const fin = this.cb.finalizeAssistantText();
        if (fin) this.callbacks.emitCardEvent(fin);
      } else if (this.textPartIds.get(tp.id) !== tp.text) {
        // Late growth — append the delta so we don't lose tokens.
        const prev = this.textPartIds.get(tp.id) ?? '';
        const delta = tp.text.startsWith(prev) ? tp.text.slice(prev.length) : tp.text;
        this.textPartIds.set(tp.id, tp.text);
        if (delta) {
          this.callbacks.emitCardEvent(this.cb.assistantText(delta));
          const fin = this.cb.finalizeAssistantText();
          if (fin) this.callbacks.emitCardEvent(fin);
        }
      }
      return;
    }
    if (part.type === 'reasoning') {
      const rp = part as ReasoningPart;
      this.partKinds.set(rp.id, 'reasoning');
      if (!rp.text) return;
      const prev = this.reasoningPartIds.get(rp.id) ?? '';
      if (prev === rp.text) return;
      const delta = rp.text.startsWith(prev) ? rp.text.slice(prev.length) : rp.text;
      this.reasoningPartIds.set(rp.id, rp.text);
      const buffered = this.deltaBuf.get(rp.id);
      if (buffered?.field === 'reasoning') buffered.text = '';
      if (delta) this.callbacks.emitCardEvent(this.cb.thinkingBlock(delta));
      return;
    }
    if (part.type === 'tool') {
      const tp = part as ToolPart;
      this.emitToolPart(tp.tool, tp.callID, tp.state);
      return;
    }
    if (part.type === 'step-finish') {
      const sp = part as StepFinishPart;
      this.turnInputTokens = sp.tokens.input;
      this.turnOutputTokens = sp.tokens.output;
      this.turnCacheRead = sp.tokens.cache.read;
      this.turnCacheWrite = sp.tokens.cache.write;
      this.turnCost = sp.cost;
      return;
    }
    // file / snapshot / patch / agent / retry / compaction → no card.
  }

  private emitToolPart(
    rawToolName: string,
    callID: string,
    state: { status?: string; input?: Record<string, unknown>; output?: string; error?: string },
  ): void {
    const toolName = normalizeOpenCodeToolName(rawToolName);
    const input = normalizeOpenCodeToolInput(rawToolName, state.input ?? {});
    const fingerprint = JSON.stringify([toolName, input]);
    const previous = this.toolCards.get(callID);
    if (previous === undefined) {
      this.toolCards.set(callID, fingerprint);
      this.callbacks.onToolUse?.(this.sessionId, toolName, input);
      this.callbacks.emitCardEvent(this.cb.toolUse(toolName, input, callID));
    } else if (previous !== fingerprint) {
      this.toolCards.set(callID, fingerprint);
      const evt = this.cb.updateToolUse(callID, toolName, input);
      if (evt) this.callbacks.emitCardEvent(evt);
    }

    // OpenCode's `task` tool runs an agent independently, but exposes it as
    // an ordinary ToolPart rather than the dedicated lifecycle events used by
    // Claude and Codex. Mirror that lifecycle into a SubagentCard so the
    // provider-neutral Agents sidebar can show OpenCode tasks as well.
    if (rawToolName === 'task') {
      this.emitOpenCodeTask(callID, input, state);
    }

    if ((state.status === 'completed' || state.status === 'error') && !this.toolResults.has(callID)) {
      this.toolResults.add(callID);
      const isError = state.status === 'error';
      const content = isError
        ? (state.error || state.output || 'Tool failed')
        : (state.output ?? '');
      const evt = this.cb.toolResult(callID, content, isError);
      if (evt) this.callbacks.emitCardEvent(evt);
    }
  }

  private emitOpenCodeTask(
    callID: string,
    input: Record<string, unknown>,
    state: { status?: string; output?: string; error?: string },
  ): void {
    const prompt = firstTaskString(input, 'prompt', 'description', 'task');
    const subagentType = firstTaskString(input, 'subagent_type', 'subagentType', 'agent');
    const requestedModel = firstTaskString(input, 'model');
    if (!this.cb.hasSubagent(callID)) {
      this.callbacks.emitCardEvent(this.cb.subagentStart(
        prompt || subagentType || 'OpenCode task',
        callID,
        callID,
        { prompt, subagentType, requestedModel, nestToolCalls: false },
      ));
    }

    if (state.status === 'completed' || state.status === 'error') {
      const summary = (state.status === 'error' ? state.error : state.output)?.trim() || undefined;
      const evt = this.cb.subagentEnd(
        callID,
        callID,
        state.status === 'completed' ? 'completed' : 'failed',
        summary,
      );
      if (evt) this.callbacks.emitCardEvent(evt);
    }
  }

  private async handlePermissionAsked(ev: OpenCodeEvent): Promise<void> {
    // Verified payload (opencode 1.14):
    //   { id, sessionID, permission, patterns, metadata, always,
    //     tool: { messageID, callID } }
    // The `tool.callID` lets us bind the request to the in-flight tool_call
    // card; `metadata` carries tool-specific args (e.g. {filepath} for read).
    const req = ev.properties as {
      id?: string;
      title?: string;
      permission?: string;
      patterns?: string[];
      metadata?: Record<string, unknown>;
      tool?: { messageID?: string; callID?: string };
      sessionID?: string;
    };
    const requestID = req.id;
    if (!requestID) return;
    if (this.permissionLevel === 'auto') {
      // Match `opencode run --auto`: approve requests that reached "ask"
      // exactly once. Explicit deny rules are enforced by OpenCode before an
      // event is emitted and therefore remain effective.
      await this.server.replyPermission(requestID, this.directory, 'once').catch((err) => {
        console.error('[openCode] auto-approve permission reply failed', err);
      });
      return;
    }
    const rawToolName = req.permission ?? req.title ?? 'permission';
    const toolName = normalizeOpenCodeToolName(rawToolName);
    const toolInput = normalizeOpenCodeToolInput(rawToolName, {
      ...(req.metadata ?? {}),
      ...(req.patterns?.length && req.metadata?.patterns === undefined
        ? { patterns: req.patterns }
        : {}),
    });
    try {
      const decision = await this.callbacks.handlePermissionRequest(this.sessionId, {
        toolName,
        toolInput,
        toolUseId: requestID,
      });
      const reply: 'once' | 'always' | 'reject' = decision.action === 'allow' ? 'once' : 'reject';
      await this.server.replyPermission(
        requestID,
        this.directory,
        reply,
        decision.action === 'deny' ? decision.response : undefined,
      );
    } catch (err) {
      console.error('[openCode] permission handling failed', err);
      await this.server.replyPermission(requestID, this.directory, 'reject').catch(() => {});
    }
  }

  private emitErrorCard(msg: string): void {
    const fin = this.cb.finalizeAssistantText();
    if (fin) this.callbacks.emitCardEvent(fin);
    this.callbacks.emitCardEvent(this.cb.assistantText(`[opencode error] ${msg}`));
    const fin2 = this.cb.finalizeAssistantText();
    if (fin2) this.callbacks.emitCardEvent(fin2);
  }

  finalize(success: boolean, error?: string): void {
    if (this.finalized) return;
    // Drain any tool sync in-flight, then run one last sweep so every tool
    // part REST knows about lands in the card list before stream-end. This
    // is the "A" half of the catch-up policy ("B" = mid-turn polls on
    // session.diff / new text partID).
    void this.finalizeAsync(success, error);
  }

  private async finalizeAsync(success: boolean, error?: string): Promise<void> {
    if (this.finalized) return;
    await this.waitForToolSync();
    try {
      await this.syncToolPartsFromRest();
    } catch (err) {
      console.warn('[openCode] final tool sync failed:', err);
    }
    if (this.finalized) return;
    this.finalized = true;
    this.flushPendingReasoning();
    const fin = this.cb.finalizeAssistantText();
    if (fin) this.callbacks.emitCardEvent(fin);
    const end: CardStreamEnd = {
      sessionId: this.sessionId,
      success,
      ...(error ? { error } : {}),
      ...(this.turnInputTokens || this.turnOutputTokens || this.turnCost
        ? {
            tokenUsage: {
              input: this.turnInputTokens,
              output: this.turnOutputTokens,
              cacheRead: this.turnCacheRead,
              cacheCreation: this.turnCacheWrite,
              ...(this.turnModelContextWindow && this.turnModelContextWindow > 0 ? { modelContextWindow: this.turnModelContextWindow } : {}),
            },
            totalCostUsd: this.turnCost,
          }
        : {}),
    };
    this.callbacks.emitStreamEnd(end);
    // Notify SessionManager so it can mark the session inactive between
    // turns. The OpencodeSession is still alive (server keeps it) — we just
    // stop streaming this turn.
    // We deliberately do NOT call onSessionExited here: the session lives
    // on the server and can be resumed. SessionManager will reuse the same
    // session reference on the next resumeSession call.
  }
}
