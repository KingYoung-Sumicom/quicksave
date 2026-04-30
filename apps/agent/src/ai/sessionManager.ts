// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { resolve, join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { getRunDir } from '../service/singleton.js';
import type {
  AgentId,
  ClaudeSessionSummary,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
  ClaudePreferences,
  ConfigValue,
  CardEvent,
  CardHistoryResponse,
  CardStreamEnd,
  SessionNoteEntry,
  SessionRegistryEntry,
  SessionStage,
  SessionUpdatePayload,
} from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  SESSION_NOTE_HISTORY_CAP,
  matchAllowPattern,
} from '@sumicom/quicksave-shared';
import { StreamCardBuilder, buildCardsFromHistory, loadPersistedCards } from './cardBuilder.js';
import { SANDBOX_BASH_TOOL, UPDATE_SESSION_STATUS_TOOL } from './sandboxMcp.js';
import { getSessionRegistry } from './sessionRegistry.js';
import { getEventStore } from '../storage/eventStore.js';
import { buildSystemPrompt } from './systemPrompt.js';
import type {
  ClaudePermissionMode,
  CodexPermissionPreset,
  PermissionLevel,
  ProviderSession,
  ProviderCallbacks,
  CodingAgentProvider,
} from './provider.js';
import {
  defaultPermissionLevelForAgent,
  isFullAccessPermission,
  isPermissionLevelAcceptedForAgent,
  normalizePermissionLevelForAgent,
} from './provider.js';

/**
 * Events emitted:
 *   'card-event'             (event: CardEvent)
 *   'card-stream-end'        (result: CardStreamEnd)
 *   'user-input-request'     (request: ClaudeUserInputRequestPayload)
 *   'user-input-resolved'    ({ requestId, sessionId })
 *   'session-updated'        ({ sessionId, isActive, isStreaming, hasPendingInput, permissionMode })
 *   'preferences-updated'    (prefs: ClaudePreferences)
 *   'session-config-updated' ({ sessionId, config: Record<string, ConfigValue> })
 */

/** Tools auto-approved at each permission level (no user prompt). */
const CLAUDE_AUTO_APPROVE: Record<ClaudePermissionMode, Set<string>> = {
  bypassPermissions: new Set([
    'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree',
    'WebFetch', 'WebSearch', 'Bash',
    'Skill', 'ToolSearch', 'Config',
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
    'EnterPlanMode', 'ExitPlanMode',
    'TaskOutput', 'TaskStop',
  ]),
  acceptEdits: new Set(['Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode']),
  default:     new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
  plan:        new Set(['EnterPlanMode']),
  auto:        new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
};

const CODEX_AUTO_APPROVE: Record<CodexPermissionPreset, Set<string>> = {
  'read-only': new Set(['EnterPlanMode']),
  default: new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
  'auto-review': new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
  'full-access': new Set([
    'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree',
    'WebFetch', 'WebSearch', 'Bash',
    'Skill', 'ToolSearch', 'Config',
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
    'EnterPlanMode', 'ExitPlanMode',
    'TaskOutput', 'TaskStop',
  ]),
};

const SESSION_STAGES: readonly SessionStage[] = [
  'investigating',
  'working',
  'verifying',
  'done',
] as const;

function isSessionStage(value: string): value is SessionStage {
  return (SESSION_STAGES as readonly string[]).includes(value);
}

function autoApproveToolsFor(agentId: AgentId, level: PermissionLevel): Set<string> {
  const normalized = normalizePermissionLevelForAgent(agentId, level);
  if (agentId === 'codex') {
    return CODEX_AUTO_APPROVE[normalized as CodexPermissionPreset];
  }
  return CLAUDE_AUTO_APPROVE[normalized as ClaudePermissionMode];
}

/**
 * Map a user response string back to each question in an AskUserQuestion call.
 *
 * Single question: response is the raw answer (may contain commas for multi-select).
 * Multiple questions: PWA joins per-question answers with `\n` (see
 * InteractiveQuestionView.handleSubmitAll). We split on `\n` and pair each line
 * with questions[i].question as the key — matching the shape the SDK's
 * AskUserQuestionOutput.answers uses.
 */
function buildAskUserAnswers(
  questions: Array<{ question?: string }> | undefined,
  responseText: string,
): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!questions || questions.length === 0) return answers;
  if (questions.length === 1) {
    if (questions[0]?.question) answers[questions[0].question] = responseText;
    return answers;
  }
  const parts = responseText.split('\n');
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]?.question;
    if (!q) continue;
    answers[q] = parts[i] ?? '';
  }
  return answers;
}

function normalizeAgentId(value: unknown): AgentId | undefined {
  if (value === 'claude-code' || value === 'claude-cli' || value === 'claude-sdk') {
    return 'claude-code';
  }
  if (value === 'codex' || value === 'codex-mcp') {
    return 'codex';
  }
  return undefined;
}

export interface ManagedSession {
  sessionId: string;
  agentId: AgentId;
  providerSession: ProviderSession | null;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
  /** Model the current provider process was spawned with. Used to force cold resume when model changes. */
  spawnedModel?: string;
  /** Auto-compact window currently active on the provider (Claude CLI only).
   *  For the CLI provider this tracks the latest value pushed via the stdin
   *  `update_environment_variables` frame — set on spawn (in
   *  `claudeCliProvider.spawnAndConsume`) and re-set on every live change in
   *  `setSessionConfig`. Used by the resume path's mismatch check as a
   *  safety net when a non-CLI provider (SDK / Codex without
   *  `updateContextWindow`) needs a cold-respawn to pick up a new tier. */
  spawnedContextWindow?: number;
  /** Per-session UUID baked into the PermissionRequest hook command. The daemon
   *  toggles bypass by creating/removing the sentinel file at `bypassFlagPath(bypassToken)`. */
  bypassToken: string;
  /** Epoch ms of the most recent SDK message whose `usage` reported a cache
   *  hit or write. Provider fires `onCacheTouch` per inner API call; this is
   *  the most reliable anchor for the PWA's prompt-cache countdown because
   *  Anthropic refreshes the TTL on every cache use. Mirrored to the event
   *  store as `cache_touched` (throttled — see CACHE_TOUCH_PERSIST_INTERVAL_MS)
   *  so a daemon restart inside the cache window doesn't lose the anchor. */
  lastCacheTouchAt?: number;
  /** Last epoch ms persisted to the `cache_touched` event log. Used purely as
   *  a throttle gate so the SDK's per-message cache notifications don't churn
   *  SQLite during tool-heavy turns. */
  lastPersistedCacheTouchAt?: number;
}

/** How often we record a `cache_touched` event to the event store. Anthropic's
 *  cache TTL is 5min (default) or 1h (extended), so 30s persistence resolution
 *  is more than enough; the live PWA countdown still ticks per second off the
 *  in-memory `lastCacheTouchAt`. Lower values mean tighter post-restart accuracy
 *  at the cost of more DB writes during long agentic loops. */
const CACHE_TOUCH_PERSIST_INTERVAL_MS = 30_000;

/** Max of optional numbers, dropping `undefined`. Returns `undefined` when both
 *  inputs are undefined (or 0) so we don't render a stale "1970" anchor. */
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  const v = Math.max(a ?? 0, b ?? 0);
  return v > 0 ? v : undefined;
}

/** Absolute path to the per-session bypass sentinel file. Hook command checks
 *  `[ -f <path> ]` — presence means auto-approve every tool. */
export function bypassFlagPath(token: string): string {
  return join(getRunDir(), 'bypass', token);
}

/** Create or remove the sentinel file atomically. Swallows I/O errors — a
 *  missing/unwritable sentinel just falls through to the prompt-tool flow. */
function applyBypassFlag(token: string, active: boolean): void {
  const path = bypassFlagPath(token);
  try {
    if (active) {
      mkdirSync(join(getRunDir(), 'bypass'), { recursive: true });
      writeFileSync(path, '');
    } else {
      rmSync(path, { force: true });
    }
  } catch (err) {
    console.warn(`[session-manager] bypass flag ${active ? 'set' : 'clear'} failed for ${token.slice(0, 8)}:`, err);
  }
}

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, ManagedSession> = new Map();
  private sessionAgents: Map<string, AgentId> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map();
  private sessionSandboxed: Map<string, boolean> = new Map();
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private runtimeAllowPatterns: string[] = [];
  private preferences: ClaudePreferences = { model: DEFAULT_MODEL };
  private providers: Map<AgentId, CodingAgentProvider>;
  private defaultAgentId: AgentId;

  /** Guards against concurrent cold resumes. Queues prompts arriving while a spawn is in flight. */
  private coldResumeInFlight: Map<string, { queuedPrompts: string[] }> = new Map();

  constructor(providers: CodingAgentProvider[], defaultAgentId: AgentId = DEFAULT_AGENT) {
    super();
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.defaultAgentId = this.providers.has(defaultAgentId)
      ? defaultAgentId
      : providers[0]?.id ?? DEFAULT_AGENT;
  }

  private getProvider(agentId?: AgentId): CodingAgentProvider {
    const resolved = agentId && this.providers.has(agentId)
      ? agentId
      : this.defaultAgentId;
    const provider = this.providers.get(resolved);
    if (!provider) {
      throw new Error(`Unknown agent: ${agentId ?? resolved}`);
    }
    return provider;
  }

  private resolveAgentId(
    sessionId: string,
    cwd?: string,
    requestedAgent?: AgentId,
  ): AgentId {
    const activeAgent = this.sessions.get(sessionId)?.agentId;
    if (activeAgent) return activeAgent;

    const rememberedAgent = this.sessionAgents.get(sessionId);
    if (rememberedAgent) return rememberedAgent;

    const rawConfig = this.sessionConfigs.get(sessionId);
    const configAgent = normalizeAgentId(rawConfig?.agent ?? rawConfig?.provider);
    if (configAgent && this.providers.has(configAgent)) {
      return configAgent;
    }

    if (cwd) {
      const registryEntry = getSessionRegistry().getEntry(cwd, sessionId);
      const registryAgent = normalizeAgentId(
        registryEntry?.agent
          ?? ((registryEntry as { provider?: string } | undefined)?.provider),
      );
      if (registryAgent && this.providers.has(registryAgent)) {
        return registryAgent;
      }
    }

    const normalizedRequest = normalizeAgentId(requestedAgent);
    if (normalizedRequest && this.providers.has(normalizedRequest)) {
      return normalizedRequest;
    }

    return this.defaultAgentId;
  }

  private resolveKnownSessionAgentId(sessionId: string): AgentId {
    const activeAgent = this.sessions.get(sessionId)?.agentId;
    if (activeAgent) return activeAgent;

    const rememberedAgent = this.sessionAgents.get(sessionId);
    if (rememberedAgent) return rememberedAgent;

    const rawConfig = this.sessionConfigs.get(sessionId);
    const configAgent = normalizeAgentId(rawConfig?.agent ?? rawConfig?.provider);
    if (configAgent && this.providers.has(configAgent)) return configAgent;

    const registryAgent = normalizeAgentId(getSessionRegistry().findBySessionId(sessionId)?.agent);
    if (registryAgent && this.providers.has(registryAgent)) return registryAgent;

    return this.defaultAgentId;
  }

  // ── Preferences ──

  async initPreferences(): Promise<void> {
    // Model is tracked from the last session's init event via onModelDetected callback.
  }

  getPreferences(): ClaudePreferences {
    return { ...this.preferences };
  }

  setPreferences(prefs: Partial<ClaudePreferences>): ClaudePreferences {
    const next = { ...this.preferences };
    let changed = false;

    if (prefs.model !== undefined && prefs.model !== this.preferences.model) {
      next.model = prefs.model;
      changed = true;
    }

    if (prefs.reasoningEffort !== undefined && prefs.reasoningEffort !== this.preferences.reasoningEffort) {
      next.reasoningEffort = prefs.reasoningEffort;
      changed = true;
    }

    if (prefs.contextWindow !== undefined && prefs.contextWindow !== this.preferences.contextWindow) {
      next.contextWindow = prefs.contextWindow;
      changed = true;
    }

    if (changed) {
      this.preferences = next;
      this.emit('preferences-updated', this.preferences);
    }

    return { ...this.preferences };
  }

  // ── Session Config ──

  getSessionConfig(sessionId: string): Record<string, ConfigValue> {
    return { ...this.sessionConfigs.get(sessionId) };
  }

  /** Snapshot of every tracked session's config. Used by the bus
   *  `/sessions/config` subscription snapshot. */
  getAllSessionConfigs(): Record<string, Record<string, ConfigValue>> {
    const out: Record<string, Record<string, ConfigValue>> = {};
    for (const [id, cfg] of this.sessionConfigs.entries()) {
      out[id] = { ...cfg };
    }
    return out;
  }

  async setSessionConfig(sessionId: string, key: string, value: ConfigValue): Promise<Record<string, ConfigValue>> {
    const prev = this.sessionConfigs.get(sessionId) ?? {};
    const next = { ...prev, [key]: value };
    this.sessionConfigs.set(sessionId, next);

    if (key === 'model' && typeof value === 'string') {
      // model/effort are session-scoped — do NOT mirror into the
      // SessionManager's global `preferences` bag. Doing so used to broadcast
      // them on `/preferences`, which the PWA writes into the *claude-code*
      // agent prefs bucket — causing a Codex GPT pick to corrupt the user's
      // saved Claude default and leak across sessions on resume.
      // Codex app-server sessions pick the change up on the next turn/start
      // via the runtime override pipeline. Claude's model is fixed per
      // session; the value here is consumed by the next cold resume.
      this.enqueueCodexOverrideIfApplicable(sessionId, { model: value });
      this.persistRegistryField(sessionId, 'model', value);
    } else if (key === 'reasoningEffort' && (typeof value === 'string' || value === null)) {
      const effort = value === null ? null : (value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'none');
      this.enqueueCodexOverrideIfApplicable(sessionId, { effort });
      this.persistRegistryField(sessionId, 'reasoningEffort', value ?? undefined);
    } else if (key === 'permissionMode' && typeof value === 'string') {
      try {
        await this.setPermissionLevel(sessionId, value);
        next.permissionMode = this.getPermissionLevel(sessionId);
      } catch (err) {
        // CLI rejected the mode (e.g. auto mode not supported for this model/plan).
        // Roll back the optimistic config change and rethrow.
        this.sessionConfigs.set(sessionId, prev);
        this.emit('session-config-updated', { sessionId, config: prev });
        throw err;
      }
      this.persistRegistryField(sessionId, 'permissionMode', next.permissionMode);
    } else if (key === 'sandboxed' && typeof value === 'boolean') {
      this.sessionSandboxed.set(sessionId, value);
      const ps = this.sessions.get(sessionId);
      if (ps) ps.sandboxed = value;
      this.persistRegistryField(sessionId, 'sandboxed', value || undefined);
    } else if (key === 'contextWindow' && typeof value === 'number' && value > 0) {
      // Live-switch the auto-compact ceiling on the running CLI without
      // respawn. Falls back to the legacy "kill on next prompt" path
      // (driven by spawnedContextWindow !== desiredContextWindow check
      // in resumeSession) when the active provider doesn't implement
      // `updateContextWindow` — only ClaudeCliProvider does today; SDK
      // and Codex providers omit it.
      const ps = this.sessions.get(sessionId);
      const session = ps?.providerSession as ProviderSession | undefined;
      if (ps?.providerSession?.alive && session && typeof session.updateContextWindow === 'function') {
        // `[1m]` model decoration is a one-way ratchet: only upgrade,
        // never strip mid-session. If the user downgrades from 1M to 200k
        // while the buffer is already >200k, stripping `[1m]` would cap
        // the API at 200k and the very compaction call needed to shrink
        // the buffer would also be rejected — deadlock. Keeping `[1m]`
        // through the downgrade is harmless: the env-side threshold
        // still forces auto-compact at 200k, so no >200k request goes
        // out anyway. Decoration realigns naturally on the next
        // cold-respawn.
        const { decorateModelWithContextWindow } = await import('./claudeCliProvider.js');
        const bareModel = ps.spawnedModel;
        const oldDecorated = decorateModelWithContextWindow(bareModel, ps.spawnedContextWindow);
        const newDecorated = decorateModelWithContextWindow(bareModel, value);
        const upgradingTo1m = !!bareModel
          && /\[1m\]$/i.test(newDecorated ?? '')
          && !/\[1m\]$/i.test(oldDecorated ?? '');
        try {
          await session.updateContextWindow(value, upgradingTo1m ? newDecorated : undefined);
          ps.spawnedContextWindow = value;
        } catch (err) {
          // Provider write failed — leave spawnedContextWindow stale so the
          // next prompt triggers a cold-respawn fallback. Don't roll back
          // sessionConfigs since the user-intended value is what should
          // apply on respawn.
          console.warn(`[session-manager] updateContextWindow failed, will cold-respawn on next prompt:`, err);
        }
      }
      this.persistRegistryField(sessionId, 'contextWindow', value);
    } else if (key === 'agent' || key === 'provider') {
      // Reject agent changes on active sessions — agent type is immutable once spawned
      const ps = this.sessions.get(sessionId);
      if (ps) {
        this.emit('session-config-updated', { sessionId, config: next });
        return next;
      }
      const agentId = normalizeAgentId(value);
      if (!agentId || !this.providers.has(agentId)) {
        this.emit('session-config-updated', { sessionId, config: next });
        return next;
      }
      this.sessionAgents.set(sessionId, agentId);
    }

    this.emit('session-config-updated', { sessionId, config: next });
    return next;
  }

  // ── Session Lifecycle ──

  async startSession(opts: {
    prompt: string;
    cwd: string;
    agent?: AgentId;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
    sandboxed?: boolean;
    reasoningEffort?: string;
    /** Auto-compact ceiling for Claude Code (200k / 500k / 1M). Codex ignores. */
    contextWindow?: number;
  }): Promise<string> {
    const provider = this.getProvider(opts.agent);
    const level = normalizePermissionLevelForAgent(provider.id, opts.permissionMode);
    const sandboxed = !!opts.sandboxed;
    const systemPrompt = buildSystemPrompt(provider.id, opts.systemPrompt);

    // Mint a per-session bypass token up front. The CLI bakes its path into
    // the PermissionRequest hook at spawn time; later toggles just touch/rm
    // the sentinel file without a respawn.
    const bypassToken = randomUUID();
    applyBypassFlag(bypassToken, isFullAccessPermission(provider.id, level));

    // Create cardBuilder with 'pending' sessionId — will be updated after provider returns real one
    const cardBuilder = new StreamCardBuilder('pending', opts.cwd);

    const callbacks = this.makeCallbacks(provider.id);

    const { sessionId, session: providerSession } = await provider.startSession(
      {
        prompt: opts.prompt,
        cwd: opts.cwd,
        model: opts.model,
        permissionLevel: level,
        sandboxed,
        systemPrompt,
        reasoningEffort: opts.reasoningEffort,
        contextWindow: opts.contextWindow,
        bypassFlagPath: bypassFlagPath(bypassToken),
      },
      cardBuilder,
      callbacks,
    );

    // Update cardBuilder with real sessionId — new session has no prior JSONL
    cardBuilder.updateSessionId(sessionId);
    cardBuilder.jsonlCutoff = 0;

    // Update callbacks to use real sessionId (re-bind the closures)
    // The callbacks are already handed to the provider; for the permission handler
    // we capture `sessionId` from the request parameter, so this is safe.

    // Register session
    this.sessionAgents.set(sessionId, provider.id);
    this.sessionPermissions.set(sessionId, level);
    if (sandboxed) this.sessionSandboxed.set(sessionId, true);

    const prevConfig = this.sessionConfigs.get(sessionId) ?? {};
    // Resolve the model that was actually used for the spawn so the PWA can
    // render the right model immediately (no waiting for onModelDetected).
    // For codex we still record the user's requested model — the codex
    // provider will overwrite via onModelDetected once it reports back.
    const recordedModel = opts.model
      ?? (typeof prevConfig.model === 'string' ? prevConfig.model : undefined)
      ?? (provider.id !== 'codex' ? DEFAULT_MODEL : undefined);
    this.sessionConfigs.set(sessionId, {
      ...prevConfig,
      agent: provider.id,
      ...(recordedModel !== undefined ? { model: recordedModel } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
      permissionMode: level,
      sandboxed,
    });

    const managed: ManagedSession = {
      sessionId,
      agentId: provider.id,
      providerSession,
      cwd: opts.cwd,
      streaming: true,
      permissionLevel: level,
      sandboxed,
      cardBuilder,
      spawnedModel: opts.model,
      spawnedContextWindow: opts.contextWindow,
      bypassToken,
    };
    this.sessions.set(sessionId, managed);
    this.emitSessionUpdate(sessionId);

    return sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    agent?: AgentId;
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);
    const agentId = this.resolveAgentId(opts.sessionId, opts.cwd, opts.agent);

    // Force cold resume if the user changed model OR context window since the
    // session was spawned. The active provider process was started with
    // `--model X` and the auto-compact env var; changing either requires
    // killing it and respawning with the new value.
    const sessionCfg = this.sessionConfigs.get(opts.sessionId);
    const desiredModel = (sessionCfg?.model as string | undefined)
      ?? this.preferences.model;
    const desiredContextWindow = (sessionCfg?.contextWindow as number | undefined)
      ?? this.preferences.contextWindow;
    const modelChanged = existing?.providerSession?.alive
      && existing.spawnedModel !== undefined
      && desiredModel !== undefined
      && existing.spawnedModel !== desiredModel;
    const contextWindowChanged = existing?.providerSession?.alive
      && existing.spawnedContextWindow !== undefined
      && desiredContextWindow !== undefined
      && existing.spawnedContextWindow !== desiredContextWindow;

    if (modelChanged || contextWindowChanged) {
      const reason = modelChanged
        ? `model changed (${existing!.spawnedModel} → ${desiredModel})`
        : `context window changed (${existing!.spawnedContextWindow} → ${desiredContextWindow})`;
      console.log(`[session-manager] ${reason} — killing provider for cold resume session=${opts.sessionId.slice(0, 8)}`);
      existing!.providerSession!.kill();
      existing!.streaming = false;
      existing!.providerSession = null;
    }

    // Hot resume (active turn): provider is mid-turn — just hand it the new prompt.
    if (existing?.streaming && existing.providerSession?.alive) {
      console.log(`[session-manager] hot resume (active) session=${opts.sessionId.slice(0, 8)}`);
      existing.providerSession.sendUserMessage(opts.prompt);
      return opts.sessionId;
    }

    // Hot resume (idle): CLI alive but between turns — reuse the same process
    // instead of cold-resuming. Saves a kill+spawn per follow-up prompt and
    // avoids the brief isActive=false window that caused the "ghost inactive"
    // badge flicker between turns.
    if (existing?.providerSession?.alive && !modelChanged && !contextWindowChanged) {
      console.log(`[session-manager] hot resume (idle) session=${opts.sessionId.slice(0, 8)}`);
      const ps = existing.providerSession as any;
      if (existing.cardBuilder) {
        existing.cardBuilder.cancelDeferredClear?.();
      }
      ps.resultEmitted = false;
      existing.streaming = true;
      existing.providerSession.sendUserMessage(opts.prompt);
      this.emitSessionUpdate(opts.sessionId);
      return opts.sessionId;
    }

    // Cold resume already in flight — queue the prompt instead of spawning again
    const inFlight = this.coldResumeInFlight.get(opts.sessionId);
    if (inFlight) {
      console.log(`[session-manager] cold resume in flight, queuing prompt for session=${opts.sessionId.slice(0, 8)}`);
      inFlight.queuedPrompts.push(opts.prompt);
      return opts.sessionId;
    }

    // Cold resume: mark as in-flight, then delegate to provider
    console.log(`[session-manager] cold resume session=${opts.sessionId.slice(0, 8)}`);
    const flight = { queuedPrompts: [] as string[] };
    this.coldResumeInFlight.set(opts.sessionId, flight);

    try {
      // Restore session settings from in-memory maps, falling back to persisted
      // registry (survives daemon restarts).
      const registryEntry = getSessionRegistry().getEntry(opts.cwd, opts.sessionId);
      const sandboxed = this.sessionSandboxed.get(opts.sessionId) ?? registryEntry?.sandboxed ?? false;
      const provider = this.getProvider(agentId);
      const level = normalizePermissionLevelForAgent(
        provider.id,
        this.sessionPermissions.get(opts.sessionId) ?? registryEntry?.permissionMode,
      );

      const cardBuilder = existing?.cardBuilder ?? new StreamCardBuilder(opts.sessionId, opts.cwd);
      await cardBuilder.snapshotCutoff();
      const callbacks = this.makeCallbacks(provider.id);

      const sessionConfig = this.sessionConfigs.get(opts.sessionId);
      // Resolution order: in-memory session config > persisted registry entry
      // > daemon's global preference fallback. Registry persistence is what
      // makes per-session settings survive a daemon restart.
      const resumeModel = (sessionConfig?.model as string | undefined)
        ?? registryEntry?.model
        ?? this.preferences.model;
      const resumeReasoningEffort = (sessionConfig?.reasoningEffort as string | undefined)
        ?? registryEntry?.reasoningEffort
        ?? this.preferences.reasoningEffort;
      const resumeContextWindow = (sessionConfig?.contextWindow as number | undefined)
        ?? registryEntry?.contextWindow
        ?? this.preferences.contextWindow;

      // Reuse the existing session's bypass token if present; otherwise mint a
      // fresh one (happens when cold-resuming a session we don't have in memory,
      // e.g. after a daemon restart).
      const bypassToken = existing?.bypassToken ?? randomUUID();
      applyBypassFlag(bypassToken, isFullAccessPermission(provider.id, level));

      const { sessionId, session: providerSession } = await provider.resumeSession(
        {
          sessionId: opts.sessionId,
          prompt: opts.prompt,
          cwd: opts.cwd,
          model: resumeModel,
          permissionLevel: level,
          sandboxed,
          systemPrompt: buildSystemPrompt(provider.id),
          reasoningEffort: resumeReasoningEffort,
          contextWindow: resumeContextWindow,
          bypassFlagPath: bypassFlagPath(bypassToken),
        },
        cardBuilder,
        callbacks,
      );

      // Seed sessionConfigs so /sessions/config snapshot reflects the
      // settings the session was actually resumed with — important when the
      // session was loaded purely from the registry (no prior in-memory
      // config) and the PWA has nothing to show otherwise.
      const resumedConfig: Record<string, ConfigValue> = {
        ...(this.sessionConfigs.get(sessionId) ?? {}),
        agent: provider.id,
        permissionMode: level,
        sandboxed,
        ...(resumeModel !== undefined ? { model: resumeModel } : {}),
        ...(resumeReasoningEffort !== undefined ? { reasoningEffort: resumeReasoningEffort } : {}),
        ...(resumeContextWindow !== undefined ? { contextWindow: resumeContextWindow } : {}),
      };
      this.sessionConfigs.set(sessionId, resumedConfig);
      // If the CLI forked to a new session id, also key the config under the
      // requested id so older subscribers that haven't seen the rekey still
      // resolve to the right config.
      if (sessionId !== opts.sessionId) {
        this.sessionConfigs.set(opts.sessionId, resumedConfig);
      }
      this.emit('session-config-updated', { sessionId, config: resumedConfig });

      // Update or create session entry
      this.sessionAgents.set(sessionId, provider.id);
      if (existing) {
        existing.agentId = provider.id;
        existing.sessionId = sessionId;
        existing.providerSession = providerSession;
        existing.streaming = true;
        existing.spawnedModel = resumeModel;
        existing.spawnedContextWindow = resumeContextWindow;
        // Cold resume can fork a new CLI session_id. Rekey the map + side
        // maps to the new ID so emitSessionUpdate finds the entry and the
        // PWA sees isActive=true (the ghost-inactive bug otherwise).
        if (sessionId !== opts.sessionId) {
          this.sessions.delete(opts.sessionId);
          this.sessions.set(sessionId, existing);
          this.migrateSessionIdState(opts.sessionId, sessionId);
          // Tell PWA the old id is defunct so its store doesn't keep a
          // stale active entry for the previous session_id.
          this.emitSessionUpdate(opts.sessionId);
        }
      } else {
        const managed: ManagedSession = {
          sessionId,
          agentId: provider.id,
          providerSession,
          cwd: opts.cwd,
          streaming: true,
          permissionLevel: level,
          sandboxed,
          cardBuilder,
          spawnedModel: resumeModel,
          spawnedContextWindow: resumeContextWindow,
          bypassToken,
        };
        this.sessions.set(sessionId, managed);
      }

      this.emitSessionUpdate(sessionId);

      // Drain queued prompts that arrived while spawning
      for (const queued of flight.queuedPrompts) {
        console.log(`[session-manager] draining queued prompt for session=${sessionId.slice(0, 8)}`);
        providerSession.sendUserMessage(queued);
      }

      return sessionId;
    } finally {
      this.coldResumeInFlight.delete(opts.sessionId);
    }
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession) return false;
    console.log(`[session-manager] cancel session=${sessionId.slice(0, 8)}`);
    ps.providerSession.interrupt();
    // The CLI abandons its can_use_tool RPC after interrupt, so any awaiter
    // on our side would hang forever. Resolve outstanding permissions with
    // deny: it unblocks the daemon promise, frees the map slot, and matches
    // user intent ("stop" = don't do that thing).
    this.cancelPendingInputsForSession(sessionId);
    return true;
  }

  /** Send a raw control_request to the active provider session (CLI only). */
  async sendControlRequest(sessionId: string, subtype: string, params?: Record<string, unknown>): Promise<unknown> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession?.alive) {
      throw new Error('Session is not active');
    }
    const session = ps.providerSession as any;
    if (typeof session.sendControlRequest !== 'function') {
      throw new Error('Provider does not support raw control_request');
    }
    return session.sendControlRequest(subtype, params);
  }

  closeSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    if (ps.providerSession) {
      ps.providerSession.kill();
      ps.providerSession = null;
    }
    if (ps.bypassToken) applyBypassFlag(ps.bypassToken, false);
    this.sessions.delete(sessionId);
    // Drop any pending permission promises for this session — the CLI is dead
    // so any later resolveUserInput would land on an orphan promise, and the
    // map entry would leak forever.
    this.cancelPendingInputsForSession(sessionId);
    this.emitSessionUpdate(sessionId);
    return true;
  }

  /** Resolve and remove every pending user-input request for a session that
   *  is going away. Used by closeSession and onSessionExited so the map
   *  doesn't leak and any awaiter unblocks with a deny. */
  private cancelPendingInputsForSession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      if (pending.request.sessionId !== sessionId) continue;
      pending.resolve({ sessionId, requestId, action: 'deny' });
      this.pendingInputRequests.delete(requestId);
    }
  }

  // ── Permission ──

  async setPermissionLevel(sessionId: string, requestedLevel: string): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    const agentId = this.resolveKnownSessionAgentId(sessionId);
    if (!isPermissionLevelAcceptedForAgent(agentId, requestedLevel)) {
      throw new Error(`Permission mode "${requestedLevel}" is not valid for ${agentId}`);
    }
    const level = normalizePermissionLevelForAgent(agentId, requestedLevel);
    const prevLevel = normalizePermissionLevelForAgent(
      agentId,
      ps?.permissionLevel ?? this.sessionPermissions.get(sessionId),
    );

    if (ps) ps.permissionLevel = level;
    this.sessionPermissions.set(sessionId, level);

    // bypass is driven by the daemon-owned sentinel file the CLI's hook
    // checks. Toggle it first so the next tool call sees the right state.
    if (ps?.bypassToken) {
      applyBypassFlag(ps.bypassToken, isFullAccessPermission(agentId, level));
    }

    const session = ps?.providerSession as any;
    if (session?.alive && typeof session.sendControlRequest === 'function') {
      // bypassPermissions is handled entirely on the daemon side (hook + AUTO_APPROVE).
      // Send `default` to the CLI so it never enters its own bypass mode.
      const cliMode = isFullAccessPermission(agentId, level) ? 'default' : level;
      try {
        await session.sendControlRequest('set_permission_mode', { mode: cliMode });
      } catch (err) {
        // CLI rejected — roll back in-memory state so config stays consistent with the CLI.
        if (ps) ps.permissionLevel = prevLevel;
        this.sessionPermissions.set(sessionId, prevLevel);
        if (ps?.bypassToken) {
          applyBypassFlag(ps.bypassToken, isFullAccessPermission(agentId, prevLevel));
        }
        this.emitSessionUpdate(sessionId);
        throw err;
      }
    } else if (session?.alive && typeof session.enqueueRuntimeOverride === 'function') {
      // Codex app-server: queue approvalPolicy/sandboxPolicy/approvalsReviewer
      // changes that take effect on the next turn/start. We import the
      // mapping lazily to avoid pulling the full app-server module into
      // the SDK-only build path.
      try {
        const { permissionLevelToOverrides } = await import('./codexAppServer/permissionMapping.js');
        const sandboxed = ps?.sandboxed ?? this.sessionSandboxed.get(sessionId) ?? true;
        const cwd = ps?.cwd;
        session.enqueueRuntimeOverride(
          permissionLevelToOverrides(level, { sandboxed, cwd }),
        );
      } catch (err) {
        if (ps) ps.permissionLevel = prevLevel;
        this.sessionPermissions.set(sessionId, prevLevel);
        this.emitSessionUpdate(sessionId);
        throw err;
      }
    }

    if (ps) {
      this.emitSessionUpdate(sessionId);
    } else {
      // Inactive session: emitSessionUpdate would carry archived=true (since
      // the session isn't in the in-memory map), which the PWA reads as a
      // "session retired" signal and bounces the user off the page. Persist
      // to the registry instead so the new mode applies on the next cold
      // resume; the PWA's optimistic state already reflects the change.
      this.persistRegistryField(sessionId, 'permissionMode', level);
    }
    return true;
  }

  getPermissionLevel(sessionId: string): PermissionLevel {
    const agentId = this.resolveKnownSessionAgentId(sessionId);
    return this.sessions.get(sessionId)?.permissionLevel
      ?? this.sessionPermissions.get(sessionId)
      ?? defaultPermissionLevelForAgent(agentId);
  }

  /**
   * Forward a runtime override to a Codex `app-server` session if the
   * active session has one. Detected by duck-typing the
   * `enqueueRuntimeOverride` method (defined on
   * `CodexAppServerProviderSession`). Other provider sessions silently
   * ignore — Claude's mid-session model swap is impossible, and the
   * SDK Codex provider doesn't have a runtime path.
   */
  private enqueueCodexOverrideIfApplicable(
    sessionId: string,
    patch: Record<string, unknown>,
  ): void {
    const ps = this.sessions.get(sessionId);
    const session = ps?.providerSession as
      | { enqueueRuntimeOverride?: (patch: Record<string, unknown>) => void }
      | undefined;
    if (!session || typeof session.enqueueRuntimeOverride !== 'function') return;
    try {
      session.enqueueRuntimeOverride(patch);
    } catch {
      // best-effort; the next turn/start surfaces any real failure
    }
  }

  resolveUserInput(response: ClaudeUserInputResponsePayload): boolean {
    const pending = this.pendingInputRequests.get(response.requestId);
    if (!pending) return false;
    this.pendingInputRequests.delete(response.requestId);
    pending.resolve(response);

    // Clear pending input on the card
    const ps = this.sessions.get(pending.request.sessionId);
    if (ps?.cardBuilder) {
      const cardEvt = ps.cardBuilder.clearPendingInput(response.requestId);
      if (cardEvt) this.emit('card-event', cardEvt);
    }

    // Persist allow pattern to settings.local.json if provided
    if (response.allowPattern && ps?.cwd) {
      this.persistAllowPattern(ps.cwd, response.allowPattern).catch((err) => {
        console.error('[persistAllowPattern] failed:', err);
      });
    }

    this.emit('user-input-resolved', { requestId: response.requestId, sessionId: pending.request.sessionId });
    // Skip the session-update emit when the session is no longer in memory:
    // buildSessionUpdatePayload would set archived=true and navigate the PWA
    // off the page. Can happen if the CLI exited (or was rekeyed) between
    // sending the permission request and the user responding.
    if (ps) this.emitSessionUpdate(pending.request.sessionId);
    return true;
  }

  // ── Query ──

  getActiveSessions(): { sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string; sandboxed?: boolean }[] {
    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map(p => p.request.sessionId)
    );
    return Array.from(this.sessions.entries()).map(([id, ps]) => ({
      sessionId: id,
      cwd: ps.cwd,
      agent: ps.agentId,
      isStreaming: ps.streaming,
      hasPendingInput: pendingSessionIds.has(id),
      permissionMode: ps.permissionLevel,
      sandboxed: ps.sandboxed || undefined,
    }));
  }

  isStreaming(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.streaming ?? false;
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /** Fetch a live context-window breakdown from the provider. Returns null if
   * the session has no live provider process or the provider doesn't support
   * `get_context_usage` (only the claude-code CLI does). */
  async getSessionContextUsage(sessionId: string): Promise<import('@sumicom/quicksave-shared').ContextUsageBreakdown | null> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession?.alive) return null;
    if (typeof ps.providerSession.getContextUsage !== 'function') return null;
    return ps.providerSession.getContextUsage();
  }

  getSessionAgent(sessionId: string, cwd?: string): AgentId {
    return this.resolveAgentId(sessionId, cwd);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getCardBuilder(sessionId: string): StreamCardBuilder | null {
    return this.sessions.get(sessionId)?.cardBuilder ?? null;
  }

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const registry = getSessionRegistry();
    const registryEntries = registry.getEntriesForProject(cwd);

    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map(p => p.request.sessionId)
    );

    const eventStore = getEventStore();
    return registryEntries.map(entry => {
      const stats = eventStore.getSessionStats(entry.sessionId);
      const lastTurn = eventStore.getLastTurn(entry.sessionId);
      return {
        sessionId: entry.sessionId,
        summary: entry.title ?? entry.firstPrompt ?? entry.sessionId.slice(0, 8),
        lastModified: entry.lastAccessedAt,
        createdAt: entry.createdAt,
        cwd: entry.cwd,
        agent: this.sessions.get(entry.sessionId)?.agentId
          ?? this.sessionAgents.get(entry.sessionId)
          ?? entry.agent
          ?? ((entry as { provider?: string }).provider === 'codex-mcp' ? 'codex' : (entry as { provider?: string }).provider ? 'claude-code' : undefined),
        gitBranch: entry.gitBranch,
        messageCount: entry.messageCount,
        isActive: this.sessions.has(entry.sessionId),
        isStreaming: this.sessions.get(entry.sessionId)?.streaming ?? false,
        hasPendingInput: pendingSessionIds.has(entry.sessionId),
        permissionMode: this.sessions.get(entry.sessionId)?.permissionLevel
          ?? this.sessionPermissions.get(entry.sessionId),
        lastPromptAt: stats.lastPromptAt ?? undefined,
        lastTurnEndedAt: stats.lastTurnEndedAt ?? undefined,
        // Prefer the in-memory anchor when available (it ticks per-message;
        // the event-store value is throttled to once per 30s) and fall back
        // to the persisted value for sessions that are registry-only.
        lastCacheTouchAt: maxDefined(
          this.sessions.get(entry.sessionId)?.lastCacheTouchAt,
          stats.lastCacheTouchAt ?? undefined,
        ),
        turnCount: stats.turnCount,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCostUsd: stats.totalCostUsd,
        lastTurnInputTokens: lastTurn?.inputTokens,
        lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
        lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
        lastTurnContextUsage: lastTurn?.contextUsage as ClaudeSessionSummary['lastTurnContextUsage'],
      };
    });
  }

  async getCards(sessionId: string, cwd: string, offset = 0, limit = 50): Promise<CardHistoryResponse> {
    const ps = this.sessions.get(sessionId);
    const provider = this.getProvider(this.resolveAgentId(sessionId, cwd));
    const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;
    let result: CardHistoryResponse;

    if (provider.historyMode === 'claude-jsonl') {
      // Read JSONL history up to the cutoff (excludes the active turn's messages).
      result = await buildCardsFromHistory(sessionId, cwd, offset, limit, cutoff);
    } else {
      // Memory-mode: use in-memory cards from active turn, falling back to persisted history
      const streamCards = ps?.cardBuilder?.getCards() ?? [];
      const persisted = await loadPersistedCards(sessionId);
      const cards = [...persisted, ...streamCards];
      const total = cards.length;
      const start = Math.max(0, total - offset - limit);
      const end = Math.max(0, total - offset);
      result = {
        cards: cards.slice(start, end),
        total,
        hasMore: start > 0,
      };
    }

    // Append in-memory cards for the active turn (initial load only — pagination
    // already has these cards in the PWA's array, so appending them again would duplicate).
    if (offset === 0 && provider.historyMode === 'claude-jsonl' && ps?.cardBuilder) {
      const streamingCards = ps.cardBuilder.getCards();
      if (streamingCards.length > 0) {
        result.cards.push(...streamingCards);
        result.total += streamingCards.length;
      }
    }

    // Overlay pending inputs from pendingInputRequests onto matching cards.
    const pendingByToolUseId = new Map<string, any>();
    for (const [, pending] of this.pendingInputRequests) {
      if (pending.request.sessionId === sessionId && pending.request.toolUseId) {
        pendingByToolUseId.set(pending.request.toolUseId, {
          sessionId: pending.request.sessionId,
          requestId: pending.request.requestId,
          inputType: pending.request.inputType,
          title: pending.request.title,
          message: pending.request.message,
          options: pending.request.options,
        });
      }
    }

    if (pendingByToolUseId.size > 0) {
      for (const card of result.cards) {
        if (card.type === 'tool_call' && (card as any).toolUseId) {
          const pending = pendingByToolUseId.get((card as any).toolUseId);
          if (pending && !(card as any).pendingInput) {
            (card as any).pendingInput = pending;
          }
        }
      }
    }

    // Attach session title from config or registry
    const configTitle = this.sessionConfigs.get(sessionId)?.title as string | undefined;
    if (configTitle) {
      result.title = configTitle;
    } else {
      const registry = getSessionRegistry();
      const entry = registry.getEntry(cwd, sessionId);
      if (entry?.title) result.title = entry.title;
    }

    return result;
  }

  getPendingInputRequests(): ClaudeUserInputRequestPayload[] {
    return Array.from(this.pendingInputRequests.values()).map(p => p.request);
  }

  /** True when a user-input-request is outstanding for this session. Used by
   *  the daemon to avoid firing a redundant "session idle" push when the
   *  card-stream-end is actually a permission-prompt pause. */
  hasPendingInputForSession(sessionId: string): boolean {
    for (const p of this.pendingInputRequests.values()) {
      if (p.request.sessionId === sessionId) return true;
    }
    return false;
  }

  getDebugState() {
    const pendingInputs = Array.from(this.pendingInputRequests.values()).map(p => ({
      requestId: p.request.requestId,
      sessionId: p.request.sessionId,
      toolName: p.request.toolName,
      agentId: (p.request as any).agentId,
      inputType: p.request.inputType,
    }));
    return { pendingInputs, activeSessions: this.getActiveSessions() };
  }

  cleanup(): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      pending.resolve({ sessionId: '', requestId, action: 'allow' });
    }
    this.pendingInputRequests.clear();

    for (const [, ps] of this.sessions) {
      if (ps.providerSession) {
        try { ps.providerSession.kill(); } catch {}
        ps.providerSession = null;
      }
    }
    this.sessions.clear();
  }

  // ── Private: Callbacks Factory ──

  makeCallbacks(agentId: AgentId): ProviderCallbacks {
    return {
      emitCardEvent: (event: CardEvent) => {
        this.emit('card-event', event);
      },
      emitStreamEnd: (result: CardStreamEnd) => {
        this.emit('card-stream-end', result);
        // Update session streaming state
        const ps = this.sessions.get(result.sessionId);
        if (ps) {
          ps.streaming = false;
          this.emitSessionUpdate(result.sessionId);
        }
      },
      handlePermissionRequest: async (
        sessionId: string,
        req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
      ) => {
        return this.handlePermissionRequest(sessionId, req);
      },
      onToolUse: (sessionId: string, toolName: string, toolInput: Record<string, unknown>) => {
        // Claude CLI's auto permission mode skips can_use_tool for MCP tools,
        // so handlePermissionRequest can't reliably drive side effects here.
        if (toolName === UPDATE_SESSION_STATUS_TOOL) {
          this.updateSessionStatus(sessionId, toolInput);
        }
      },
      onCacheTouch: (sessionId: string) => {
        const ps = this.sessions.get(sessionId);
        if (!ps) return;
        const now = Date.now();
        ps.lastCacheTouchAt = now;
        const lastPersisted = ps.lastPersistedCacheTouchAt ?? 0;
        if (now - lastPersisted >= CACHE_TOUCH_PERSIST_INTERVAL_MS) {
          getEventStore().record({
            type: 'cache_touched',
            sessionId,
            cwd: ps.cwd,
            time: now,
          });
          ps.lastPersistedCacheTouchAt = now;
        }
        this.emitSessionUpdate(sessionId);
      },
      onModelDetected: (model: string) => {
        console.log(`[session-manager] model detected: ${model} (agent=${agentId})`);
        if (agentId === 'claude-code') {
          this.preferences.model = model;
        }
      },
      onSessionExited: (sessionId, providerSession) => {
        const ps = this.sessions.get(sessionId);
        // Stale callback — a newer provider has already taken this slot
        // (e.g. cold resume killed this one and spawned a fresh CLI).
        if (!ps || ps.providerSession !== providerSession) return;
        console.log(`[session-manager] provider exited session=${sessionId.slice(0, 8)} — marking inactive`);
        ps.providerSession = null;
        ps.streaming = false;
        if (ps.bypassToken) applyBypassFlag(ps.bypassToken, false);
        this.sessions.delete(sessionId);
        this.cancelPendingInputsForSession(sessionId);
        this.emitSessionUpdate(sessionId);
      },
    };
  }

  // ── Private: Permission Handling ──

  private async handlePermissionRequest(
    sessionId: string,
    req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
  ): Promise<{ action: 'allow' | 'deny'; response?: string; updatedInput?: Record<string, unknown> }> {
    const { toolName, toolInput, toolUseId } = req;

    // Check auto-approve rules first
    if (this.shouldAutoApprove(sessionId, toolName, toolInput)) {
      return { action: 'allow' };
    }

    // Check runtime allow patterns
    if (this.runtimeAllowPatterns.some(p => matchAllowPattern(p, toolName, toolInput))) {
      return { action: 'allow' };
    }

    // Forward to PWA for user decision
    const requestId = `perm-${++this.requestCounter}`;

    const isQuestion = toolName === 'AskUserQuestion';
    const questions = isQuestion ? (toolInput as any).questions : undefined;

    const request: ClaudeUserInputRequestPayload = {
      sessionId,
      requestId,
      inputType: isQuestion ? 'question' : 'permission',
      title: isQuestion
        ? questions?.[0]?.question ?? 'Question from Claude'
        : `Allow ${toolName}?`,
      message: isQuestion ? undefined : JSON.stringify(toolInput).slice(0, 500),
      toolName,
      toolInput,
      toolUseId,
      ...(isQuestion && questions ? {
        options: questions.flatMap((q: any) =>
          (q.options ?? []).map((opt: any) => ({
            key: opt.label,
            label: opt.label,
            description: opt.description,
          }))
        ),
      } : {}),
    };

    // Create card with pending input
    const ps = this.sessions.get(sessionId);
    const cb = ps?.cardBuilder;
    if (cb) {
      const pendingAttachment = {
        sessionId,
        requestId,
        inputType: request.inputType,
        title: request.title,
        message: request.message,
        options: request.options,
      };
      const cardEvt = cb.toolCallFromPermission(toolName, toolInput, toolUseId, pendingAttachment);
      this.emit('card-event', cardEvt);
    }

    this.emit('user-input-request', request);

    // Wait for user response
    const response = await this.waitForUserInput(requestId, request);

    if (response.action === 'deny') {
      return { action: 'deny', response: response.response || 'User denied permission' };
    }

    // For AskUserQuestion, inject answer
    if (isQuestion && response.response) {
      const answers = buildAskUserAnswers(questions, response.response);

      // Mirror the answers onto the ToolCallCard so the PWA can render the
      // user's selections immediately — regardless of what the CLI later
      // emits as the tool_result content.
      if (cb && Object.keys(answers).length > 0) {
        const evt = cb.setToolAnswers(toolUseId, answers);
        if (evt) this.emit('card-event', evt);
      }

      return { action: 'allow', updatedInput: { ...toolInput, answers } };
    }

    return { action: 'allow' };
  }

  private shouldAutoApprove(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    // UpdateSessionStatus — always approve. The actual metadata write happens
    // in the onToolUse callback (driven by the assistant stream), because
    // CLI auto mode pre-approves MCP tools without ever sending can_use_tool.
    if (toolName === UPDATE_SESSION_STATUS_TOOL) {
      return true;
    }

    // SandboxBash: auto-approve when sandboxed, otherwise check as Bash
    if (toolName === SANDBOX_BASH_TOOL) {
      if (this.sessions.get(sessionId)?.sandboxed) return true;
      toolName = 'Bash';  // fall through to permission check as Bash
    }

    // Check permission level auto-approve set
    const agentId = this.resolveKnownSessionAgentId(sessionId);
    const level = this.sessions.get(sessionId)?.permissionLevel
      ?? this.sessionPermissions.get(sessionId)
      ?? defaultPermissionLevelForAgent(agentId);

    if (!autoApproveToolsFor(agentId, level).has(toolName)) return false;

    // For file-writing tools, restrict to project cwd
    const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const cwd = this.sessions.get(sessionId)?.cwd;
      const filePath = (input.file_path ?? input.path) as string | undefined;
      if (filePath && cwd) {
        const resolvedFile = resolve(filePath);
        const resolvedCwd = resolve(cwd);
        return resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + '/');
      }
    }

    return true;
  }

  /**
   * Update session ticket-model status (triggered by the UpdateSessionStatus MCP tool).
   * Partial update: only fields present in `input` are written. Unknown-typed inputs
   * are validated here before being applied to session config / registry.
   *
   * `note`, when supplied, is appended to the session's `noteHistory` log in the
   * registry (capped at SESSION_NOTE_HISTORY_CAP, oldest-first). The latest note
   * text is also mirrored to session config / registry `note` for quick access.
   */
  private updateSessionStatus(sessionId: string, input: Record<string, unknown>): void {
    const configUpdates: Record<string, ConfigValue> = {};
    const entryUpdates: Partial<SessionRegistryEntry> = {};
    let noteToAppend: string | null = null;
    let changed = false;

    if (typeof input.subject === 'string' && input.subject.length > 0) {
      configUpdates.title = input.subject;
      entryUpdates.title = input.subject;
      changed = true;
    }

    if (typeof input.stage === 'string' && isSessionStage(input.stage)) {
      configUpdates.stage = input.stage;
      entryUpdates.stage = input.stage;
      changed = true;
    }

    if (typeof input.blocked === 'boolean') {
      configUpdates.blocked = input.blocked;
      entryUpdates.blocked = input.blocked;
      changed = true;
    }

    if (typeof input.note === 'string' && input.note.length > 0) {
      configUpdates.note = input.note;
      entryUpdates.note = input.note;
      noteToAppend = input.note;
      changed = true;
    }

    if (!changed) return;

    const prev = this.sessionConfigs.get(sessionId) ?? {};
    const next = { ...prev, ...configUpdates };
    this.sessionConfigs.set(sessionId, next);
    this.emit('session-config-updated', { sessionId, config: next });

    const ps = this.sessions.get(sessionId);
    if (ps?.cwd) {
      const registry = getSessionRegistry();
      const entry = registry.getEntry(ps.cwd, sessionId);
      if (entry) {
        let nextHistory = entry.noteHistory;
        if (noteToAppend !== null) {
          const appended: SessionNoteEntry = { ts: Date.now(), text: noteToAppend };
          const prior = Array.isArray(entry.noteHistory) ? entry.noteHistory : [];
          const combined = [...prior, appended];
          // Trim oldest-first once we exceed the cap so the registry payload
          // stays broadcast-friendly.
          nextHistory = combined.length > SESSION_NOTE_HISTORY_CAP
            ? combined.slice(combined.length - SESSION_NOTE_HISTORY_CAP)
            : combined;
        }
        registry.upsertEntry({
          ...entry,
          ...entryUpdates,
          ...(nextHistory !== entry.noteHistory ? { noteHistory: nextHistory } : {}),
          lastAccessedAt: Date.now(),
        });
      }
    }
  }

  /** Move per-session state from oldId to newId after the CLI forks on
   * --resume. `sessionAgents[newId]` is already set by the caller; this
   * helper moves the remaining side maps and clears the old key. */
  private migrateSessionIdState(oldId: string, newId: string): void {
    const permission = this.sessionPermissions.get(oldId);
    if (permission !== undefined) {
      this.sessionPermissions.set(newId, permission);
      this.sessionPermissions.delete(oldId);
    }
    const sandboxed = this.sessionSandboxed.get(oldId);
    if (sandboxed !== undefined) {
      this.sessionSandboxed.set(newId, sandboxed);
      this.sessionSandboxed.delete(oldId);
    }
    const config = this.sessionConfigs.get(oldId);
    if (config !== undefined) {
      this.sessionConfigs.set(newId, config);
      this.sessionConfigs.delete(oldId);
    }
    // Rewrite any pending input request still tagged with the old sessionId
    // so a later resolveUserInput can find the new session entry (and its
    // cardBuilder) to clear the PWA's pending-permission UI. Without this,
    // permission prompts emitted before the rekey stay stuck on screen.
    for (const [, pending] of this.pendingInputRequests) {
      if (pending.request.sessionId === oldId) {
        pending.request = { ...pending.request, sessionId: newId };
      }
    }
    this.sessionAgents.delete(oldId);
  }

  private emitSessionUpdate(sessionId: string): void {
    this.emit('session-updated', this.buildSessionUpdatePayload(sessionId));
  }

  /**
   * Build the payload normally shipped via the `session-updated` event without
   * emitting. Used by daemon-level code that wants to push a fresh snapshot to
   * a specific peer (e.g. PWA reconnect) instead of triggering a broadcast.
   */
  buildSessionUpdatePayload(sessionId: string): SessionUpdatePayload {
    const ps = this.sessions.get(sessionId);
    const hasPendingInput = Array.from(this.pendingInputRequests.values())
      .some(p => p.request.sessionId === sessionId);
    const eventStore = getEventStore();
    const stats = eventStore.getSessionStats(sessionId);
    const lastTurn = eventStore.getLastTurn(sessionId);
    return {
      sessionId,
      // `isActive` reflects in-memory presence, NOT "currently doing work".
      //   isActive=true  → session is in `this.sessions`: either streaming
      //                    (isStreaming=true) or idle — alive between turns,
      //                    awaiting user input, hot-resumable without spawning.
      //   isActive=false → registry-only (archived/closed/never-opened); a
      //                    follow-up prompt would need a cold resume.
      // The "idle" semantic (awaiting user input) is the isActive && !isStreaming
      // substate; consumers derive it rather than receiving it as its own flag.
      isActive: !!ps,
      // `archived` = session has been retired in the registry (the user ran
      // End Task, project:delete, or the entry was never created). It is
      // distinct from `!isActive`: a session that just had its CLI process
      // killed (claude:close / cold-resume rekey / onSessionExited) is
      // !isActive but still has an active registry entry, so the PWA must
      // keep the entry visible and let a follow-up prompt cold-resume it.
      // PWA uses `archived=true` as the strong "navigate away from the
      // defunct session page" signal.
      archived: !ps && !getSessionRegistry().findBySessionId(sessionId),
      agent: ps?.agentId ?? this.sessionAgents.get(sessionId),
      isStreaming: ps?.streaming ?? false,
      hasPendingInput,
      permissionMode: ps?.permissionLevel ?? this.sessionPermissions.get(sessionId),
      sandboxed: ps?.sandboxed ?? this.sessionSandboxed.get(sessionId) ?? false,
      lastPromptAt: stats.lastPromptAt ?? undefined,
      lastTurnEndedAt: stats.lastTurnEndedAt ?? undefined,
      lastCacheTouchAt: maxDefined(ps?.lastCacheTouchAt, stats.lastCacheTouchAt ?? undefined),
      turnCount: stats.turnCount,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalCostUsd: stats.totalCostUsd,
      lastTurnInputTokens: lastTurn?.inputTokens,
      lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
      lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
      lastTurnContextUsage: lastTurn?.contextUsage as SessionUpdatePayload['lastTurnContextUsage'],
    };
  }

  /** Snapshot of every in-memory session's state (both streaming and idle —
   *  "idle" here meaning alive-between-turns / awaiting user input, i.e. the
   *  hot-resumable substate). Delivered via the bus `/sessions/active` snap
   *  frame on subscribe; subsequent incremental updates are published per
   *  session via the same path.
   *
   *  Note: registry-only sessions (closed, never-opened this process) are
   *  intentionally NOT included here — the PWA learns about those via
   *  `/sessions/history` or the `claude:list-sessions` command instead. */
  snapshotActiveSessions(): SessionUpdatePayload[] {
    return Array.from(this.sessions.keys()).map((id) => this.buildSessionUpdatePayload(id));
  }

  private persistRegistryField(sessionId: string, key: string, value: unknown): void {
    const registry = getSessionRegistry();
    // Active session — cwd is in memory
    const cwd = this.sessions.get(sessionId)?.cwd;
    if (cwd) {
      registry.updateEntry(cwd, sessionId, { [key]: value } as any);
      return;
    }
    // Inactive session — scan registry for the entry
    for (const entry of registry.getEntriesForProject()) {
      if (entry.sessionId === sessionId) {
        registry.updateEntry(entry.cwd, sessionId, { [key]: value } as any);
        return;
      }
    }
  }

  private async persistAllowPattern(cwd: string, pattern: string): Promise<void> {
    if (!this.runtimeAllowPatterns.includes(pattern)) {
      this.runtimeAllowPatterns.push(pattern);
    }

    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch { /* file doesn't exist yet */ }

    const permissions = settings.permissions as Record<string, unknown> ?? {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
    if (!allow.includes(pattern)) {
      allow.push(pattern);
      settings.permissions = { ...permissions, allow };
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`[persistAllowPattern] saved ${pattern} to ${settingsPath}`);
    }
  }

  private waitForUserInput(
    requestId: string,
    request: ClaudeUserInputRequestPayload,
  ): Promise<ClaudeUserInputResponsePayload> {
    return new Promise((resolve) => {
      this.pendingInputRequests.set(requestId, { resolve, request });
      // Notify subscribers so the PWA's dot indicator flips to "pending"
      // immediately. resolveUserInput emits its own update to flip it back.
      // Guard against an inactive session: emitting then would carry
      // archived=true and bounce the PWA off the page. (Should not normally
      // happen — the CLI is alive whenever it asks for permission — but the
      // race is cheap to guard.)
      if (this.sessions.has(request.sessionId)) {
        this.emitSessionUpdate(request.sessionId);
      }
    });
  }
}
