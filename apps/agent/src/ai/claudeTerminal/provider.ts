// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * ClaudeTerminalProvider — spawns `claude` in TUI mode inside the existing
 * terminalManager PTY, intercepts turn events via hooks, tails the session
 * JSONL for structured content, and bridges everything into the same
 * CodingAgentProvider contract that ClaudeCliProvider satisfies.
 *
 * Three input channels feed cards to the PWA:
 *   - PTY screen   → live terminal panel (handled by existing terminal:* verbs)
 *   - Hook events  → tool_use / tool_result / turn boundary cards (low latency)
 *   - JSONL tail   → assistant text + final reconciliation (per-message flush)
 *
 * See docs/plans/2026-05-25-claude-terminal-provider.md for the architecture
 * rationale and probe results that justify per-message flush timing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment, AgentId, CardStreamEnd } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from '../cardBuilder.js';
import { claudeProjectDir, jsonlPath } from '../cardBuilder.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderHistoryMode,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from '../provider.js';
import { getTerminalManager } from '../../terminal/terminalManager.js';
import { getClaudeBin } from '../claudeCliProvider.js';
import { HookBridge, type HookEventName, type HookRequest } from './hookBridge.js';
import { buildHookSettings } from './settingsBuilder.js';
import { JsonlTail } from './jsonlTail.js';
import { CardSynth } from './cardSynth.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));

/**
 * Hooks we register for M2:
 *   - UserPromptSubmit: fires when the user submits text into the TUI.
 *   - PreToolUse:       fires immediately before claude executes a tool —
 *                       lets us emit a tool_use card without waiting for
 *                       the assistant message JSONL flush.
 *   - PostToolUse:      fires immediately after the tool returns — same
 *                       latency win for tool_result cards.
 *   - PermissionRequest: fires before tool execution when the tool needs
 *                       user confirmation. We bridge it to
 *                       `ProviderCallbacks.handlePermissionRequest` so the
 *                       PWA dialog (not the TUI's y/n) decides.
 *   - Stop:             fires when the assistant turn completes — anchors
 *                       the stream-end CardEvent that stops the spinner.
 */
const ACTIVE_HOOKS: HookEventName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
];

/**
 * Delay before the FIRST attempt to type into a freshly spawned TUI. Claude
 * paints the welcome screen and reads `~/.claude/projects` metadata before it
 * accepts input. Most boxes are ready by now so the prompt lands on the first
 * try; slower/cold boxes fall back to the re-type loop in
 * `sendPromptUntilAccepted` instead of relying on this single guess.
 */
const TUI_INITIAL_DELAY_MS = 1000;
/**
 * How long to wait for proof a typed prompt was accepted (the session JSONL
 * appearing / growing) before re-typing it. A cold TUI that ate the first
 * keystrokes never produces that proof, so we re-type until it does.
 */
const PROMPT_RETRY_INTERVAL_MS = 2500;
/** Gap between writing the prompt text and the submit CR so the TUI can paint. */
const PROMPT_SUBMIT_GAP_MS = 150;
/** Overall ceiling for discovering / starting the session JSONL. */
const SESSION_DISCOVER_TIMEOUT_MS = 30_000;

/**
 * Pick the right interpreter + handler path so the hook command works whether
 * the daemon runs from source (tsx, .ts file) or compiled output (node, .js).
 */
export function resolveHookCommand(): { interpreter: string; handlerPath: string } {
  // We resolve relative to this file's location. When compiled, this file is
  // `<dist>/.../claudeTerminal/provider.js` and hookHandler.js sits next to it.
  // When running via tsx in dev, this file is `<src>/.../claudeTerminal/provider.ts`
  // and hookHandler.ts sits next to it; spawning a fresh `node hookHandler.ts`
  // would fail, so we run it through `tsx`.
  const jsHandler = join(__ownDir, 'hookHandler.js');
  if (existsSync(jsHandler)) {
    return { interpreter: 'node', handlerPath: jsHandler };
  }
  // Dev: resolve `tsx` by absolute path, NOT `npx tsx`. Claude runs the hook
  // command with cwd = the user's project dir; in this pnpm monorepo `tsx`
  // lives at `apps/agent/node_modules/.bin/tsx` (not hoisted to the workspace
  // root), so `npx tsx` searches upward from the wrong cwd, falls through to a
  // registry fetch, and dies with `sh: 1: tsx: not found` — exactly the Stop
  // hook failure this guards against. See sandboxMcp.ts for the same fix.
  // __ownDir is apps/agent/src/ai/claudeTerminal → three levels up is apps/agent.
  const tsHandler = join(__ownDir, 'hookHandler.ts');
  const tsxBin = join(__ownDir, '..', '..', '..', 'node_modules', '.bin', 'tsx');
  return { interpreter: tsxBin, handlerPath: tsHandler };
}

// ============================================================================
// TerminalProviderSession — wraps a terminalManager terminal + hookBridge
// ============================================================================

class TerminalProviderSession implements ProviderSession {
  public readonly sessionId: string;
  public readonly terminalId: string;
  public readonly synth: CardSynth;
  private readonly bridge: HookBridge;
  private readonly tail: JsonlTail;
  private _alive = true;

  constructor(opts: {
    sessionId: string;
    terminalId: string;
    bridge: HookBridge;
    tail: JsonlTail;
    synth: CardSynth;
  }) {
    this.sessionId = opts.sessionId;
    this.terminalId = opts.terminalId;
    this.bridge = opts.bridge;
    this.tail = opts.tail;
    this.synth = opts.synth;
  }

  sendUserMessage(prompt: string, _attachments?: readonly Attachment[]): void {
    if (!this._alive) return;
    // TUI eats CR as submit (paste-bracketed input is handled by claude's
    // input handler). Send the prompt followed by Enter.
    try {
      getTerminalManager().write(this.terminalId, prompt);
      // Tiny delay so the TUI has time to render the prompt before the submit.
      // 60ms picked empirically — anything < 30ms races on slow boxes.
      setTimeout(() => {
        if (!this._alive) return;
        try { getTerminalManager().write(this.terminalId, '\r'); } catch { /* */ }
      }, 60);
    } catch (err) {
      console.error(`[claude-terminal] sendUserMessage failed:`, err);
    }
  }

  interrupt(): void {
    if (!this._alive) return;
    // Ctrl-C — claude TUI listens for this to abort the current turn.
    try { getTerminalManager().write(this.terminalId, '\x03'); } catch { /* */ }
  }

  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    try { getTerminalManager().close(this.terminalId, true); } catch { /* */ }
    this.tail.stop();
    void this.bridge.stop();
  }

  get alive(): boolean {
    return this._alive;
  }
}

// ============================================================================
// ClaudeTerminalProvider — implements CodingAgentProvider
// ============================================================================

export class ClaudeTerminalProvider implements CodingAgentProvider {
  readonly id: AgentId = 'claude-terminal';
  readonly historyMode: ProviderHistoryMode = 'claude-jsonl';
  readonly label = 'Claude (Terminal)';

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    return this.spawn(opts, cardBuilder, callbacks, undefined);
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    return this.spawn(opts, cardBuilder, callbacks, opts.sessionId);
  }

  private async spawn(
    opts: StartSessionOpts | ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    resumeSessionId: string | undefined,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    // 1. Hook bridge — start before we spawn claude so the socket exists.
    const bridge = new HookBridge();
    await bridge.start();

    // 2. Settings JSON with our hooks.
    const { interpreter, handlerPath } = resolveHookCommand();
    const settings = buildHookSettings({
      handlerPath,
      socketPath: bridge.socketPath,
      events: ACTIVE_HOOKS,
      nodeBin: interpreter,
    });

    // 3. Build claude argv. TUI mode = no -p, no --input-format.
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    args.push('--settings', JSON.stringify(settings));
    // Forward the user's permission preset. `bypassPermissions` skips the TUI
    // y/n prompt AND our PermissionRequest hook — exactly what the user
    // wants when they pick it. For `acceptEdits` / `plan` / `auto` we pass
    // through directly; claude TUI honors them. For `default` we omit the
    // flag and let claude use its built-in default.
    if (opts.permissionLevel && opts.permissionLevel !== 'default') {
      args.push('--permission-mode', opts.permissionLevel);
    }
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    // 4. Snapshot existing JSONLs so we can detect the new one.
    const projectDir = claudeProjectDir(opts.cwd);
    const beforeJsonls = new Set<string>();
    try {
      if (existsSync(projectDir)) {
        for (const f of readdirSync(projectDir)) {
          if (f.endsWith('.jsonl')) beforeJsonls.add(f);
        }
      }
    } catch { /* directory may not exist yet */ }

    // 5. Spawn claude inside a terminalManager terminal.
    const term = await getTerminalManager().create({
      cwd: opts.cwd,
      shell: getClaudeBin(),
      args,
      cols: 120,
      rows: 30,
      title: `Claude ${resumeSessionId ? '↻' : '✨'} ${opts.cwd.split('/').pop() ?? ''}`,
    });

    // 6. CRITICAL ordering note: claude TUI does NOT create the session
    //    JSONL at startup — it lazily writes it when the FIRST user message
    //    is submitted. For new sessions we must type the prompt into the PTY
    //    BEFORE polling for the JSONL, otherwise discoverSessionId() will
    //    hit its 30s timeout waiting on a file that will never appear.
    //
    //    For resume, the file already exists and `--resume <sid>` makes
    //    claude touch it on startup, so we can poll immediately.
    // 7. Obtain the session JSONL / sessionId.
    let sessionId: string;
    try {
      if (!resumeSessionId && opts.prompt) {
        // New session: claude TUI lazily creates the session JSONL only when
        // the FIRST user message is accepted. We can't reliably guess when the
        // TUI is ready for keystrokes — cold boxes paint the welcome screen
        // slowly and silently eat early input, which used to leave
        // discoverSessionId() waiting on a JSONL that never appeared (the 30s
        // timeout seen in the field). So drive on the RESULT instead of a fixed
        // delay: type the prompt, wait briefly for the JSONL to appear, and
        // re-type if it didn't — the new JSONL is proof the prompt landed.
        const prompt = opts.prompt;
        sessionId = await sendPromptUntilAccepted({
          send: () => this.typePrompt(term.terminalId, prompt),
          probe: () => this.scanForNewJsonl(projectDir, beforeJsonls, undefined),
          timeoutMs: SESSION_DISCOVER_TIMEOUT_MS,
          initialDelayMs: TUI_INITIAL_DELAY_MS,
          retryIntervalMs: PROMPT_RETRY_INTERVAL_MS,
        });
      } else {
        // Resume: the JSONL already exists (claude touches it on `--resume`),
        // so just poll for it. The follow-up prompt is injected in the
        // background at step 11 once the session is wired.
        sessionId = await this.discoverSessionId(projectDir, beforeJsonls, resumeSessionId);
      }
    } catch (err) {
      // Don't leak the spawned PTY + socket if we never got a sessionId.
      try { getTerminalManager().close(term.terminalId, true); } catch { /* */ }
      try { await bridge.stop(); } catch { /* */ }
      throw err;
    }

    cardBuilder.updateSessionId(sessionId);

    // 8. Start tailing the JSONL.
    const tail = new JsonlTail(jsonlPath(sessionId, opts.cwd));
    tail.start(50);

    const synth = new CardSynth({
      cardBuilder,
      emit: (evt) => callbacks.emitCardEvent(evt),
    });

    const session = new TerminalProviderSession({
      sessionId,
      terminalId: term.terminalId,
      bridge,
      tail,
      synth,
    });

    // 9. Wire hook events → callbacks.
    bridge.onRequest((req) => this.handleHookRequest(req, session, cardBuilder, callbacks));

    // 10. Wire JSONL messages → cardBuilder.
    tail.on('message', (msg) => this.handleJsonlMessage(msg, session, cardBuilder, callbacks));

    // 11. Resume path: inject the follow-up prompt now that the session is
    //     wired. (New-session prompt was already accepted before step 7.)
    //
    //     Unlike the new-session path, discoverSessionId returns almost
    //     immediately on resume — `--resume <sid>` makes claude touch the
    //     existing JSONL on startup — so we never block long enough for the TUI
    //     to finish painting, and an early keystroke gets eaten. Rather than
    //     guess a fixed warmup, drive on the same result signal (JSONL growth)
    //     and re-type if needed. Runs in the background: we already have the
    //     sessionId, so callers must not block on acceptance.
    if (resumeSessionId && opts.prompt) {
      void this.injectResumePrompt(session, tail.path, opts.prompt);
    }

    return { sessionId, session };
  }

  /**
   * Type a prompt into the TUI: write the text, then submit with Enter after a
   * short render gap. Resolves once the CR has been written so callers in a
   * re-type loop submit one prompt at a time (no overlapping setTimeout CRs).
   * This only spaces the text from the submit — it does NOT wait for the TUI to
   * be ready; readiness is handled by the re-type loop in sendPromptUntilAccepted.
   */
  private async typePrompt(terminalId: string, prompt: string): Promise<void> {
    const tm = getTerminalManager();
    try {
      tm.write(terminalId, prompt);
      // Tiny gap so the TUI renders the prompt before the submit CR lands.
      await sleep(PROMPT_SUBMIT_GAP_MS);
      tm.write(terminalId, '\r');
    } catch (err) {
      console.error('[claude-terminal] typePrompt failed:', err);
    }
  }

  /**
   * Synchronously scan the project dir for a session JSONL. For a new session,
   * returns the basename of any .jsonl not present in `before`. For resume,
   * returns `expectResume` once its file exists. Returns null if none match.
   */
  private scanForNewJsonl(
    projectDir: string,
    before: Set<string>,
    expectResume: string | undefined,
  ): string | null {
    try {
      if (existsSync(projectDir)) {
        for (const f of readdirSync(projectDir)) {
          if (!f.endsWith('.jsonl')) continue;
          if (expectResume) {
            if (f === `${expectResume}.jsonl`) return expectResume;
          } else if (!before.has(f)) {
            return f.slice(0, -'.jsonl'.length);
          }
        }
      }
    } catch { /* directory may not exist yet */ }
    return null;
  }

  /**
   * Resume: inject the follow-up prompt into the live TUI in the background.
   * We already have the sessionId, so this doesn't block startSession. Drives on
   * a result signal — the existing JSONL growing past its pre-prompt size — and
   * re-types if the TUI ate the keystrokes before it was ready.
   */
  private async injectResumePrompt(
    session: TerminalProviderSession,
    jsonlFilePath: string,
    prompt: string,
  ): Promise<void> {
    let baseline: number | null = null;
    try {
      await sendPromptUntilAccepted({
        send: () => this.typePrompt(session.terminalId, prompt),
        probe: () => {
          let size: number;
          try { size = statSync(jsonlFilePath).size; } catch { return null; }
          // First probe (after initialDelay) anchors the baseline so claude's
          // own resume-startup writes aren't mistaken for our prompt landing.
          if (baseline === null) { baseline = size; return null; }
          return size > baseline ? String(size) : null;
        },
        abort: () => !session.alive,
        timeoutMs: SESSION_DISCOVER_TIMEOUT_MS,
        initialDelayMs: TUI_INITIAL_DELAY_MS,
        retryIntervalMs: PROMPT_RETRY_INTERVAL_MS,
      });
    } catch (err) {
      if (session.alive) {
        console.error('[claude-terminal] resume prompt injection failed:', err);
      }
    }
  }

  /**
   * After spawn, watch the project dir for a fresh .jsonl that's not in
   * `before`. Returns its session id (the basename without .jsonl).
   *
   * For resume, the file already exists — we just wait for it to appear if it
   * doesn't yet (claude touches it on startup).
   */
  private async discoverSessionId(
    projectDir: string,
    before: Set<string>,
    expectResume: string | undefined,
  ): Promise<string> {
    const deadline = Date.now() + SESSION_DISCOVER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const sid = this.scanForNewJsonl(projectDir, before, expectResume);
      if (sid) return sid;
      await sleep(100);
    }
    throw new Error('claude-terminal: session JSONL did not appear within 30s');
  }

  private handleHookRequest(
    req: HookRequest,
    session: TerminalProviderSession,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): void {
    switch (req.event) {
      case 'UserPromptSubmit':
        // Fire-and-forget. Future: mark activeTurn = true, snapshot jsonlCutoff.
        req.respond(null);
        return;

      case 'PreToolUse': {
        const p = req.payload as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
        const tool_use_id = typeof p.tool_use_id === 'string' ? p.tool_use_id : '';
        const tool_name = typeof p.tool_name === 'string' ? p.tool_name : 'unknown';
        const tool_input = (p.tool_input && typeof p.tool_input === 'object')
          ? p.tool_input as Record<string, unknown>
          : {};
        if (tool_use_id) session.synth.emitToolUse(tool_use_id, tool_name, tool_input);
        callbacks.onToolUse?.(session.sessionId, tool_name, tool_input);
        req.respond(null);
        return;
      }

      case 'PostToolUse': {
        const p = req.payload as {
          tool_use_id?: string;
          tool_response?: unknown;
          is_error?: boolean;
        };
        const tool_use_id = typeof p.tool_use_id === 'string' ? p.tool_use_id : '';
        if (tool_use_id) {
          const content = CardSynth.stringifyHookToolResponse(p.tool_response);
          session.synth.emitToolResult(tool_use_id, content, !!p.is_error);
        }
        req.respond(null);
        return;
      }

      case 'PermissionRequest': {
        // ASYNC — listener returns immediately; respond is called from the
        // PWA dialog promise resolution. HookBridge has a fallback timer
        // (HOOK_RESPONSE_FALLBACK_MS = 30s) so a hanging dialog can't lock
        // the TUI forever.
        const p = req.payload as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
        const toolName = typeof p.tool_name === 'string' ? p.tool_name : 'unknown';
        const toolInput = (p.tool_input && typeof p.tool_input === 'object')
          ? p.tool_input as Record<string, unknown>
          : {};
        const toolUseId = typeof p.tool_use_id === 'string' ? p.tool_use_id : '';
        callbacks.handlePermissionRequest(session.sessionId, { toolName, toolInput, toolUseId })
          .then((decision) => {
            if (decision.action === 'deny') {
              req.respond({
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: { behavior: 'deny', message: decision.response || 'Denied' },
                },
              });
            } else {
              req.respond({
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: { behavior: 'allow' },
                },
              });
            }
          })
          .catch((err) => {
            console.error('[claude-terminal] permission callback failed:', err);
            req.respond(null);
          });
        return;
      }

      case 'Stop': {
        // Emit a stream-end card so the PWA spinner stops.
        const streamEnd: CardStreamEnd = {
          sessionId: session.sessionId,
          success: true,
        };
        callbacks.emitStreamEnd(streamEnd);
        void cardBuilder.scheduleDeferredClear();
        req.respond(null);
        return;
      }

      default:
        req.respond(null);
    }
  }

  private handleJsonlMessage(
    msg: { type?: string; message?: { content?: unknown; role?: string }; subtype?: string },
    session: TerminalProviderSession,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): void {
    // Assistant turn: text → card, tool_use → routed through synth (deduped
    // against PreToolUse hook).
    if (msg.type === 'assistant' && msg.message?.content) {
      const blocks = msg.message.content as Array<{
        type?: string;
        text?: string;
        name?: string;
        id?: string;
        input?: Record<string, unknown>;
      }>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          callbacks.emitCardEvent(cardBuilder.assistantText(block.text));
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : 'unknown';
          const input = (block.input && typeof block.input === 'object') ? block.input : {};
          session.synth.emitToolUse(block.id, name, input);
          callbacks.onToolUse?.(session.sessionId, name, input);
        }
      }
    }
    // User turn: prompt text → card, tool_result blocks → routed through synth
    // (deduped against PostToolUse hook).
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (typeof content === 'string' && content) {
        callbacks.emitCardEvent(cardBuilder.userMessage(content));
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{
          type?: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            callbacks.emitCardEvent(cardBuilder.userMessage(block.text));
          } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const text = CardSynth.stringifyHookToolResponse(block.content);
            session.synth.emitToolResult(block.tool_use_id, text, !!block.is_error);
          }
        }
      }
    }
    // System init carries the model — surface it.
    if (msg.type === 'system' && msg.subtype === 'init') {
      const model = (msg as { model?: string }).model;
      if (model) callbacks.onModelDetected(model);
    }
    // Structured per-turn system entries. Emit live so they match what
    // buildCardsFromHistory reconstructs on reload (same card shape + meta).
    if (msg.type === 'system' && msg.subtype === 'turn_duration') {
      callbacks.emitCardEvent(cardBuilder.turnDuration(msg as Record<string, unknown>));
    }
    if (msg.type === 'system' && msg.subtype === 'stop_hook_summary') {
      callbacks.emitCardEvent(cardBuilder.stopHookSummary(msg as Record<string, unknown>));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendPromptUntilAcceptedOpts {
  /** Type the prompt into the TUI (text + submit). Awaited each attempt. */
  send: () => void | Promise<void>;
  /** Check whether the prompt was accepted yet. Return a non-null token (the
   *  discovered sessionId, or any truthy marker) once accepted, else null. */
  probe: () => string | null;
  /** Overall deadline in ms. */
  timeoutMs: number;
  /** Delay before the first send (TUI warmup). Default 0. */
  initialDelayMs?: number;
  /** How long to wait for acceptance after a send before re-typing. Default 2500. */
  retryIntervalMs?: number;
  /** Poll cadence while waiting for acceptance. Default 100. */
  pollIntervalMs?: number;
  /** Optional cancel hook checked between waits — throws if it returns true. */
  abort?: () => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Type a prompt into a freshly spawned (or resumed) claude TUI and keep
 * re-typing until there's proof it was accepted, or the deadline passes.
 *
 * The TUI eats keystrokes sent before it finishes painting, and there's no
 * reliable readiness signal, so a single fixed delay is fragile on cold boxes.
 * Instead we drive on the RESULT (`probe()` going non-null — e.g. the session
 * JSONL appearing or growing): send, wait one `retryIntervalMs` window for
 * acceptance, and re-send if it didn't land. An already-accepted prompt flushes
 * its proof well within one window, so duplicate sends are rare in practice.
 *
 * @returns the token `probe()` returned on acceptance.
 * @throws if the deadline passes without acceptance, or `abort()` fires.
 */
export async function sendPromptUntilAccepted(opts: SendPromptUntilAcceptedOpts): Promise<string> {
  const initialDelayMs = opts.initialDelayMs ?? 0;
  const retryIntervalMs = opts.retryIntervalMs ?? 2500;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const napMs = opts.sleep ?? sleep;
  const clock = opts.now ?? Date.now;
  const checkAbort = () => {
    if (opts.abort?.()) throw new Error('claude-terminal: prompt injection aborted');
  };

  const deadline = clock() + opts.timeoutMs;
  if (initialDelayMs > 0) await napMs(initialDelayMs);

  while (clock() < deadline) {
    checkAbort();
    // Pre-check: on resume the prompt may already have landed from a prior
    // attempt; avoid an unnecessary duplicate send.
    const already = opts.probe();
    if (already !== null) return already;

    await opts.send();

    const windowEnd = Math.min(deadline, clock() + retryIntervalMs);
    while (clock() < windowEnd) {
      checkAbort();
      const token = opts.probe();
      if (token !== null) return token;
      await napMs(pollIntervalMs);
    }
  }
  throw new Error(
    `claude-terminal: prompt was not accepted within ${opts.timeoutMs}ms (TUI may never have become ready)`,
  );
}
