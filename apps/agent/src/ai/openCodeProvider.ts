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
// Event → Card translation (verified against opencode 1.14):
//   • `message.part.updated` is the source of truth for each part. We use it
//     in preference to `message.part.delta` so the implementation is
//     idempotent and easy to test (Card emission per Part snapshot, not per
//     delta byte). Each Part type maps as:
//       - TextPart      → assistantText + finalize
//       - ReasoningPart → thinkingBlock
//       - ToolPart      → toolUse / toolResult (depending on state.status)
//     Step / file / patch / snapshot parts are ignored — they have no card.
//   • `session.idle` is the canonical end-of-turn signal. We emit `streamEnd`
//     from there.
//   • `session.error` becomes a visible `[opencode error]` card and a failed
//     `streamEnd`.
//   • `permission.asked` is forwarded to the PWA via the usual
//     `handlePermissionRequest` callback; the reply is POSTed back to
//     `/permission/{id}/reply`.

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Attachment, CardStreamEnd, ContextUsageBreakdown } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  StartSessionOpts,
  ResumeSessionOpts,
  ProbeResult,
} from './provider.js';
import { getOpenCodeServer, type OpenCodeEvent, type OpenCodeServer } from './openCodeServer.js';

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

type AnyPart = TextPart | ReasoningPart | ToolPart | BasePart;

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
  private turnConfig: TurnConfig;
  private cb: StreamCardBuilder | null = null;
  private callbacks: ProviderCallbacks | null = null;

  constructor(opencodeSessionId: string, server: OpenCodeServer, turnConfig: TurnConfig) {
    this.opencodeSessionId = opencodeSessionId;
    this.server = server;
    this.turnConfig = turnConfig;
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
    this.server.sendPromptAsync(this.opencodeSessionId, {
      text: prompt,
      model: this.turnConfig.model,
      ...(this.turnConfig.variant ? { variant: this.turnConfig.variant } : {}),
      ...(this.turnConfig.system ? { system: this.turnConfig.system } : {}),
    }).catch((err: Error) => {
      console.error('[openCode] follow-up prompt_async failed:', err);
      this.router?.finalize(false, err.message);
    });
  }

  interrupt(): void {
    void this.server.abortSession(this.opencodeSessionId).catch(() => {});
  }

  kill(): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    void this.server.abortSession(this.opencodeSessionId).catch(() => {});
    this.dispose();
  }

  get alive(): boolean { return this.aliveFlag; }

  async getContextUsage(): Promise<ContextUsageBreakdown | null> { return null; }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class OpenCodeProvider implements CodingAgentProvider {
  readonly id = 'opencode' as const;
  readonly historyMode = 'memory' as const;
  readonly label = 'OpenCode';

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
    };
    return { capabilities, models: hasCli ? this.listAvailableModels() : [] };
  }

  // Read models from user's opencode.json. Previously shelled out to
  // `opencode models`, but every invocation leaks an 8MB libopentui.so into
  // /tmp (sst/opencode#4605, #13479; open since Feb, no fix in sight).
  // Trade-off: built-in `opencode/*` free models only show up if the user
  // adds them to their own config.
  private listAvailableModels(): Array<{ id: string; name: string }> {
    return Array.from(this.readConfigModelNames().entries()).map(([id, name]) => ({ id, name }));
  }

  private readConfigModelNames(): Map<string, string> {
    const names = new Map<string, string>();
    try {
      const home = process.env.HOME ?? '';
      const configPath = join(home, '.config', 'opencode', 'opencode.json');
      if (!existsSync(configPath)) return names;
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const providers = config?.provider as
        | Record<string, { models?: Record<string, { name?: string }> }>
        | undefined;
      if (!providers) return names;
      for (const [providerID, cfg] of Object.entries(providers)) {
        for (const [modelID, modelCfg] of Object.entries(cfg.models ?? {})) {
          const full = `${providerID}/${modelID}`;
          names.set(full, modelCfg.name ?? full);
        }
      }
    } catch { /* ignore */ }
    return names;
  }

  private isCliAvailable(): boolean {
    try {
      const bin = getOpenCodeBin();
      execSync(`"${bin}" --version`, { timeout: 3_000, encoding: 'utf-8' });
      return true;
    } catch { return false; }
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
    const server = getOpenCodeServer();
    const { id: opencodeSessionId } = await server.createSession({
      directory: opts.cwd,
      agent: 'build',
    });

    const turnConfig: TurnConfig = {
      model: parseModelId(opts.model),
      ...(opts.reasoningEffort ? { variant: opts.reasoningEffort } : {}),
      ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    };
    const session = new OpencodeSession(opencodeSessionId, server, turnConfig);
    cardBuilder.updateSessionId(opencodeSessionId);

    if (opts.prompt || (opts.attachments && opts.attachments.length > 0)) {
      callbacks.emitCardEvent(cardBuilder.userMessage(opts.prompt, opts.attachments));
    }
    cardBuilder.startNewTurn();

    const router = new SessionEventRouter(opencodeSessionId, cardBuilder, callbacks, server);
    const unsub = server.subscribe(opencodeSessionId, (ev) => router.handle(ev));
    session._setTurnWiring(cardBuilder, callbacks, router, unsub);

    server.sendPromptAsync(opencodeSessionId, {
      text: opts.prompt,
      model: turnConfig.model,
      ...(turnConfig.variant ? { variant: turnConfig.variant } : {}),
      ...(turnConfig.system ? { system: turnConfig.system } : {}),
    }).catch((err: Error) => {
      console.error('[openCode] prompt_async failed:', err);
      router.finalize(false, err.message);
    });

    return { sessionId: opencodeSessionId, session };
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
    const server = getOpenCodeServer();
    // `opts.sessionId` from SessionManager IS opencode's ses_… (we returned
    // it from startSession). Reuse it directly — no createSession.
    const opencodeSessionId = opts.sessionId;

    const turnConfig: TurnConfig = {
      model: parseModelId(opts.model),
      ...(opts.reasoningEffort ? { variant: opts.reasoningEffort } : {}),
      ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    };
    const session = new OpencodeSession(opencodeSessionId, server, turnConfig);
    cardBuilder.updateSessionId(opencodeSessionId);

    if (opts.prompt || (opts.attachments && opts.attachments.length > 0)) {
      callbacks.emitCardEvent(cardBuilder.userMessage(opts.prompt, opts.attachments));
    }
    cardBuilder.startNewTurn();

    const router = new SessionEventRouter(opencodeSessionId, cardBuilder, callbacks, server);
    const unsub = server.subscribe(opencodeSessionId, (ev) => router.handle(ev));
    session._setTurnWiring(cardBuilder, callbacks, router, unsub);

    server.sendPromptAsync(opencodeSessionId, {
      text: opts.prompt,
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

// ── SSE → CardEvent router ───────────────────────────────────────────────────

/** @internal exposed for tests; do not use outside this module. */
export class SessionEventRouter {
  private readonly sessionId: string;
  private readonly cb: StreamCardBuilder;
  private readonly callbacks: ProviderCallbacks;
  private readonly server: OpenCodeServer;
  private finalized = false;
  /** Track which parts we've already emitted as cards so re-emits become
   *  no-ops. opencode publishes both `delta` and `updated` events for the
   *  same Part; we listen only to `updated` but the same part can update
   *  many times (e.g. tool state transitions). For text parts we coalesce
   *  by holding only the latest snapshot. */
  private toolCards = new Set<string>(); // callIDs we've emitted toolUse for
  private toolResults = new Set<string>(); // callIDs we've emitted toolResult for
  private textPartIds = new Map<string, string>(); // partID → emitted text (for dedupe)
  private reasoningPartIds = new Set<string>();

  constructor(sessionId: string, cb: StreamCardBuilder, callbacks: ProviderCallbacks, server: OpenCodeServer) {
    this.sessionId = sessionId;
    this.cb = cb;
    this.callbacks = callbacks;
    this.server = server;
  }

  /** Reset turn-scoped state so the next opencode turn streams into a fresh
   *  set of cards. Per-session disposers and the SSE subscription stay live. */
  resetForNewTurn(): void {
    this.finalized = false;
    this.toolCards.clear();
    this.toolResults.clear();
    this.textPartIds.clear();
    this.reasoningPartIds.clear();
    this.deltaBuf.clear();
  }

  handle(ev: OpenCodeEvent): void {
    if (this.finalized) return;
    switch (ev.type) {
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
   *  sets keyed by callID to dedup against earlier syncs and against any
   *  future SSE-delivered `message.part.updated` events. */
  private async syncToolPartsFromRest(): Promise<void> {
    if (this.finalized) return;
    const messages = await this.server.getMessages(this.sessionId);
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
        const input = state.input ?? {};
        if (!this.toolCards.has(callID)) {
          if (!flushedText) {
            const fin = this.cb.finalizeAssistantText();
            if (fin) this.callbacks.emitCardEvent(fin);
            flushedText = true;
          }
          this.toolCards.add(callID);
          this.callbacks.onToolUse?.(this.sessionId, toolName, input);
          this.callbacks.emitCardEvent(this.cb.toolUse(toolName, input, callID));
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
    }
  }

  /** Incremental delta on a `text` or `reasoning` part. We accumulate per
   *  partID and emit per-card for clean bubble grouping. */
  private deltaBuf = new Map<string, { field: 'text' | 'reasoning'; text: string; cardOpen: boolean }>();

  private handleDelta(p: { partID: string; field: string; delta: string }): void {
    if (!p.partID || !p.delta) return;
    if (p.field !== 'text' && p.field !== 'reasoning') return;
    let state = this.deltaBuf.get(p.partID);
    if (!state) {
      state = { field: p.field, text: '', cardOpen: false };
      this.deltaBuf.set(p.partID, state);
    }
    state.text += p.delta;
    if (state.field === 'text') {
      // First chunk for this partID closes any other open text card, then
      // creates a fresh one. Subsequent chunks append to the same card via
      // assistantText() which the StreamCardBuilder coalesces.
      if (!state.cardOpen) {
        const fin = this.cb.finalizeAssistantText();
        if (fin) this.callbacks.emitCardEvent(fin);
        state.cardOpen = true;
        // A new text part starting may mean a tool just completed (opencode
        // doesn't push tool parts via SSE — we poll REST). Debounced, so a
        // spurious sync at the very first text card of the turn is cheap.
        this.scheduleToolSync();
      }
      this.callbacks.emitCardEvent(this.cb.assistantText(p.delta));
    }
    // reasoning deltas: buffer until we see a terminator. opencode doesn't
    // emit a per-part `complete` event, so we flush reasoning on the next
    // text card OR on finalize. See flushPendingReasoning().
  }

  /** Flush buffered reasoning chunks (collected via handleDelta) into a
   *  single thinkingBlock per part. Idempotent. */
  private flushPendingReasoning(): void {
    for (const [partID, state] of this.deltaBuf) {
      if (state.field === 'reasoning' && state.text) {
        this.callbacks.emitCardEvent(this.cb.thinkingBlock(state.text));
        state.text = '';
      }
      if (state.field === 'text' && state.cardOpen) {
        const fin = this.cb.finalizeAssistantText();
        if (fin) this.callbacks.emitCardEvent(fin);
        state.cardOpen = false;
      }
      void partID;
    }
  }

  private handlePart(part: AnyPart): void {
    if (!part || typeof part.type !== 'string') return;
    if (part.type === 'text') {
      const tp = part as TextPart;
      if (tp.ignored || !tp.text) return;
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
      if (!rp.text || this.reasoningPartIds.has(rp.id)) return;
      this.reasoningPartIds.add(rp.id);
      this.callbacks.emitCardEvent(this.cb.thinkingBlock(rp.text));
      return;
    }
    if (part.type === 'tool') {
      const tp = part as ToolPart;
      const input = (tp.state?.input ?? {}) as Record<string, unknown>;
      if (!this.toolCards.has(tp.callID)) {
        this.toolCards.add(tp.callID);
        this.callbacks.onToolUse?.(this.sessionId, tp.tool, input);
        this.callbacks.emitCardEvent(this.cb.toolUse(tp.tool, input, tp.callID));
      }
      if ((tp.state?.status === 'completed' || tp.state?.status === 'error') && !this.toolResults.has(tp.callID)) {
        this.toolResults.add(tp.callID);
        const isError = tp.state.status === 'error';
        const content = isError
          ? (tp.state.error || tp.state.output || 'Tool failed')
          : (tp.state.output ?? '');
        const evt = this.cb.toolResult(tp.callID, content, isError);
        if (evt) this.callbacks.emitCardEvent(evt);
      }
      return;
    }
    // step / file / snapshot / patch / agent / retry / compaction → no card.
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
      metadata?: Record<string, unknown>;
      tool?: { messageID?: string; callID?: string };
      sessionID?: string;
    };
    const requestID = req.id;
    if (!requestID) return;
    const toolName = req.permission ?? req.title ?? 'permission';
    const toolInput = (req.metadata ?? {}) as Record<string, unknown>;
    try {
      const decision = await this.callbacks.handlePermissionRequest(this.sessionId, {
        toolName,
        toolInput,
        toolUseId: requestID,
      });
      const reply: 'once' | 'always' | 'reject' = decision.action === 'allow' ? 'once' : 'reject';
      await this.server.replyPermission(requestID, reply);
    } catch (err) {
      console.error('[openCode] permission handling failed', err);
      await this.server.replyPermission(requestID, 'reject').catch(() => {});
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
