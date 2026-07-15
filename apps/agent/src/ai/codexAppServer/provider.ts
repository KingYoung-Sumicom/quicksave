// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, Attachment, ConfigValue, NativeSessionSummary, SlashCommandInfo } from '@sumicom/quicksave-shared';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StreamCardBuilder } from '../cardBuilder.js';
import { persistAttachments } from '../attachmentStore.js';
import { buildSandboxMcpServerConfig, SANDBOX_MCP_NAME } from '../sandboxMcp.js';
import type {
  CodexPermissionPreset,
  AgentCapabilities,
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderHistoryMode,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from '../provider.js';
import { normalizePermissionLevelForAgent } from '../provider.js';
import { makeQueuedUserPrompt, queueStateFor, type QueuedUserPrompt } from '../queuedUserPrompts.js';
import { getEventStore } from '../../storage/eventStore.js';

import {
  createCodexTurnStreamConsumer,
  type CodexTurnStreamConsumer,
} from './cardAdapter.js';
import {
  codexApprovalResponse,
  codexApprovalToPermissionPrompt,
  type CodexApprovalMethod,
} from './approvalMapping.js';
import { detectCodexVersion, spawnAppServer, type AppServerHandle } from './processManager.js';
import { RuntimeOverrideStore, type RuntimeOverrides } from './overrideStore.js';
import { TokenAccounting, type CumulativeUsageSeed } from './tokenAccounting.js';
import type { AskForApproval } from './schema/generated/v2/AskForApproval.js';
import type { SandboxMode } from './schema/generated/v2/SandboxMode.js';
import type { ThreadStartParams } from './schema/generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './schema/generated/v2/ThreadStartResponse.js';
import type { Thread } from './schema/generated/v2/Thread.js';
import type { ThreadListParams } from './schema/generated/v2/ThreadListParams.js';
import type { ThreadListResponse } from './schema/generated/v2/ThreadListResponse.js';
import type { ThreadResumeParams } from './schema/generated/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './schema/generated/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from './schema/generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './schema/generated/v2/TurnStartResponse.js';
import type { TurnInterruptParams } from './schema/generated/v2/TurnInterruptParams.js';
import type { TurnSteerParams } from './schema/generated/v2/TurnSteerParams.js';
import type { TurnStartedNotification } from './schema/generated/v2/TurnStartedNotification.js';
import type { TurnCompletedNotification } from './schema/generated/v2/TurnCompletedNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './schema/generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { ApprovalsReviewer } from './schema/generated/v2/ApprovalsReviewer.js';
import type { SkillsListParams } from './schema/generated/v2/SkillsListParams.js';
import type { SkillsListResponse } from './schema/generated/v2/SkillsListResponse.js';
import type { ReasoningEffort } from './schema/generated/ReasoningEffort.js';
import type { UserInput } from './schema/generated/v2/UserInput.js';
import type { ToolRequestUserInputParams } from './schema/generated/v2/ToolRequestUserInputParams.js';
import type { ToolRequestUserInputQuestion } from './schema/generated/v2/ToolRequestUserInputQuestion.js';
import type { ToolRequestUserInputResponse } from './schema/generated/v2/ToolRequestUserInputResponse.js';
import type { McpServerElicitationRequestParams } from './schema/generated/v2/McpServerElicitationRequestParams.js';
import type { McpServerElicitationRequestResponse } from './schema/generated/v2/McpServerElicitationRequestResponse.js';
import type { McpElicitationSchema } from './schema/generated/v2/McpElicitationSchema.js';
import type { McpElicitationPrimitiveSchema } from './schema/generated/v2/McpElicitationPrimitiveSchema.js';
import type { DynamicToolCallParams } from './schema/generated/v2/DynamicToolCallParams.js';
import type { DynamicToolCallResponse } from './schema/generated/v2/DynamicToolCallResponse.js';
import type { ChatgptAuthTokensRefreshParams } from './schema/generated/v2/ChatgptAuthTokensRefreshParams.js';
import type { ThreadGoal } from './schema/generated/v2/ThreadGoal.js';
import type { ThreadGoalClearParams } from './schema/generated/v2/ThreadGoalClearParams.js';
import type { ThreadGoalClearResponse } from './schema/generated/v2/ThreadGoalClearResponse.js';
import type { ThreadGoalClearedNotification } from './schema/generated/v2/ThreadGoalClearedNotification.js';
import type { ThreadGoalGetParams } from './schema/generated/v2/ThreadGoalGetParams.js';
import type { ThreadGoalGetResponse } from './schema/generated/v2/ThreadGoalGetResponse.js';
import type { ThreadGoalSetParams } from './schema/generated/v2/ThreadGoalSetParams.js';
import type { ThreadGoalSetResponse } from './schema/generated/v2/ThreadGoalSetResponse.js';
import type { ThreadGoalStatus } from './schema/generated/v2/ThreadGoalStatus.js';
import type { ThreadGoalUpdatedNotification } from './schema/generated/v2/ThreadGoalUpdatedNotification.js';
import type { JsonValue } from './schema/generated/serde_json/JsonValue.js';
import { codexProtocolPreview } from './protocolLog.js';
import { codexServerRequestInputId } from './serverRequestIds.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));
const __aiDir = dirname(__ownDir);
const CODEX_BUILT_IN_SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'goal',
    description: 'Manage Codex goal mode',
    argumentHint: 'pause | resume | clear | set <objective>',
  },
];

/**
 * Codex provider driving the JSON-RPC v2 `app-server` protocol.
 * Phase 2 of the migration — see
 * `docs/references/codex-app-server/implementation-plan.md`.
 *
 * Same lifecycle contract as `CodexSdkProvider` so SessionManager can
 * swap us in without changes.
 */
export class CodexAppServerProvider implements CodingAgentProvider {
  readonly id: AgentId = 'codex';
  readonly historyMode: ProviderHistoryMode = 'memory';
  readonly label = 'Codex';

  async probeProvider() {
    let version: string | undefined;
    try {
      version = await detectCodexVersion();
    } catch {
      // Keep the provider discoverable, but do not advertise attachment
      // support when the underlying app-server cannot be launched.
    }
    const capabilities: AgentCapabilities = {
      hasApiKey: !!process.env.OPENAI_API_KEY,
      hasCli: !!version,
      hasPlugin: true,
      supportsResume: true,
      supportsSandbox: false,
      supportsStreaming: true,
      ...(version ? {
        supportsAttachments: true,
        supportedAttachmentKinds: ['image', 'text'],
      } : {}),
    };
    return { version, capabilities };
  }

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const handle = await spawnCodexAppServer(opts);

    const threadStartParams = buildThreadStartParams(opts);
    let response: ThreadStartResponse;
    try {
      response = await handle.rpc.request<ThreadStartResponse>('thread/start', threadStartParams);
    } catch (err) {
      await handle.shutdown();
      throw err;
    }

    const tokens = new TokenAccounting();
    const overrideStore = new RuntimeOverrideStore();
    seedOverrideStoreFromResponse(overrideStore, response);
    const session = new CodexAppServerSession({
      handle,
      tokens,
      overrideStore,
      threadId: response.thread.id,
      cardBuilder,
      callbacks,
      onExitedFire: callbacks.onSessionExited,
    });
    callbacks.onModelDetected(response.model);
    void session.refreshGoalConfig().catch((err) => {
      console.warn(
        `[codex-app] failed to refresh goal session=${response.thread.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // First-turn overrides from opts (effort etc.) get queued so drain()
    // attaches them to the next turn/start.
    overrideStore.enqueue(perTurnOverridesFromOpts(opts, response));

    scheduleInitialTurn(session, opts.prompt, opts.attachments);

    return { sessionId: response.thread.id, session };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const handle = await spawnCodexAppServer(opts);

    const resumeParams = buildThreadResumeParams(opts);
    let response: ThreadResumeResponse;
    try {
      response = await handle.rpc.request<ThreadResumeResponse>('thread/resume', resumeParams);
    } catch (err) {
      await handle.shutdown();
      throw err;
    }

    const tokens = new TokenAccounting();
    tokens.seedFromLastTurn(loadCumulativeSeed(opts.sessionId));
    const overrideStore = new RuntimeOverrideStore();
    seedOverrideStoreFromResponse(overrideStore, response);

    const session = new CodexAppServerSession({
      handle,
      tokens,
      overrideStore,
      threadId: response.thread.id,
      cardBuilder,
      callbacks,
      onExitedFire: callbacks.onSessionExited,
    });
    callbacks.onModelDetected(response.model);
    void session.refreshGoalConfig().catch((err) => {
      console.warn(
        `[codex-app] failed to refresh goal session=${response.thread.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    overrideStore.enqueue(perTurnOverridesFromOpts(opts, response));
    scheduleInitialTurn(session, opts.prompt, opts.attachments);

    return { sessionId: response.thread.id, session };
  }

  async listNativeSessions(opts?: { cwd?: string }): Promise<NativeSessionSummary[]> {
    const handle = await spawnCodexNativeListAppServer();
    try {
      const [activeThreads, archivedThreads] = await Promise.all([
        listCodexThreads(handle, opts?.cwd, false),
        listCodexThreads(handle, opts?.cwd, true),
      ]);
      const byId = new Map<string, NativeSessionSummary>();
      for (const item of [
        ...activeThreads.map((thread) => codexThreadToNativeSession(thread, false)),
        ...archivedThreads.map((thread) => codexThreadToNativeSession(thread, true)),
      ]) {
        const existing = byId.get(item.sessionId);
        if (!existing || item.lastInteractionAt > existing.lastInteractionAt) {
          byId.set(item.sessionId, item);
        }
      }
      return Array.from(byId.values()).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  }
}

function scheduleInitialTurn(
  session: CodexAppServerSession,
  prompt: string,
  attachments?: readonly Attachment[],
): void {
  // Give SessionManager and messageHandler one macrotask to register the
  // session and persist the mcpCorrId-backed registry entry before the model
  // can call Quicksave's MCP tools. Without this, the first
  // UpdateSessionStatus call in a fresh Codex turn can see `source: "unknown"`.
  setTimeout(() => {
    if (session.alive) void session.runTurn(prompt, attachments);
  }, 0);
}

interface SessionArgs {
  handle: AppServerHandle;
  tokens: TokenAccounting;
  overrideStore: RuntimeOverrideStore;
  threadId: string;
  cardBuilder: StreamCardBuilder;
  callbacks: ProviderCallbacks;
  onExitedFire: ProviderCallbacks['onSessionExited'];
}

/**
 * Public Codex-app-server session interface. SessionManager checks
 * for these methods at call time so it can route `setSessionConfig`
 * (model/effort) and `setPermissionLevel` to the provider's per-turn
 * override pipeline. Other providers don't implement these and the
 * SessionManager paths fall through.
 */
export interface CodexAppServerProviderSession extends ProviderSession {
  /** Queue runtime overrides for the next `turn/start`. Multiple
   * calls before the next turn merge — last write wins per key.
   * Calling this while a turn is in flight does NOT interrupt the
   * current turn; the caller can additionally call `interrupt()`
   * if they want immediate effect. */
  enqueueRuntimeOverride(patch: RuntimeOverrides): void;
  /** True when there are queued overrides not yet sent to the
   * server. UI can use this to surface a "pending" badge. */
  hasPendingOverride(): boolean;
  /** Provider-specific control bridge used by the PWA's generic
   * `session:control-request` message. */
  sendControlRequest(subtype: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Re-read Codex thread goal state and mirror it into session config. */
  refreshGoalConfig(): Promise<void>;
}

export class CodexAppServerSession implements CodexAppServerProviderSession {
  private readonly handle: AppServerHandle;
  private readonly tokens: TokenAccounting;
  private readonly overrideStore: RuntimeOverrideStore;
  private readonly threadId: string;
  private readonly cardBuilder: StreamCardBuilder;
  private readonly callbacks: ProviderCallbacks;
  private currentTurnId: string | null = null;
  private pendingTurns: QueuedUserPrompt[] = [];
  private running = false;
  private startingRunTurn = false;
  private prestartedRunTurnId: string | null = null;
  private exited = false;
  private readonly turnConsumers = new Map<string, CodexTurnStreamConsumer>();
  private readonly settledTurnIds = new Set<string>();
  private unsubscribeSessionNotifications: (() => void) | null = null;
  private unsubscribeTransportClose: (() => void) | null = null;

  constructor(args: SessionArgs) {
    this.handle = args.handle;
    this.tokens = args.tokens;
    this.overrideStore = args.overrideStore;
    this.threadId = args.threadId;
    this.cardBuilder = args.cardBuilder;
    this.callbacks = args.callbacks;
    this.cardBuilder.updateSessionId(this.threadId);

    // Wire approval requests through the standard ProviderCallbacks bridge.
    this.handle.rpc.setServerRequestHandler(async (req) => {
      return this.handleServerRequest(req);
    });
    this.unsubscribeSessionNotifications = this.handle.rpc.onNotification((notification) => {
      this.handleSessionNotification(notification);
    });
    this.unsubscribeTransportClose = this.handle.rpc.onClose(() => {
      this.handleTransportClosed();
    });

    // If the child exits unexpectedly, mark us dead and notify SessionManager.
    this.handle.child.once('exit', () => {
      if (this.exited) return;
      this.exited = true;
      args.onExitedFire?.(this.threadId, this);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  sendUserMessage(prompt: string, attachments?: readonly Attachment[]): void {
    const activeTurnId = this.currentTurnId;
    if (activeTurnId) {
      void this.steerOrQueue(prompt, attachments, activeTurnId);
      return;
    }
    void this.runTurn(prompt, attachments);
  }

  interruptThenSendUserMessage(prompt: string, attachments?: readonly Attachment[]): void {
    if (this.currentTurnId) this.interrupt();
    this.enqueueOrRunTurn(prompt, attachments);
  }

  getQueueState() {
    return queueStateFor(this.pendingTurns, this.currentTurnId !== null);
  }

  enqueueRuntimeOverride(patch: RuntimeOverrides): void {
    this.overrideStore.enqueue(patch);
  }

  hasPendingOverride(): boolean {
    return this.overrideStore.hasPending();
  }

  async sendControlRequest(subtype: string, params?: Record<string, unknown>): Promise<unknown> {
    switch (subtype) {
      case 'goal.get':
      case 'thread/goal/get':
        return this.refreshGoalConfigAndReturn();

      case 'goal.set':
      case 'goal.update':
      case 'thread/goal/set': {
        const response = await this.handle.rpc.request<ThreadGoalSetResponse>(
          'thread/goal/set',
          this.goalSetParams(params),
        );
        this.emitGoalConfig(response.goal);
        return response;
      }

      case 'goal.pause': {
        const response = await this.handle.rpc.request<ThreadGoalSetResponse>(
          'thread/goal/set',
          { threadId: this.threadId, status: 'paused' } satisfies ThreadGoalSetParams,
        );
        this.emitGoalConfig(response.goal);
        return response;
      }

      case 'goal.resume': {
        const response = await this.handle.rpc.request<ThreadGoalSetResponse>(
          'thread/goal/set',
          { threadId: this.threadId, status: 'active' } satisfies ThreadGoalSetParams,
        );
        this.emitGoalConfig(response.goal);
        return response;
      }

      case 'goal.clear':
      case 'thread/goal/clear': {
        const response = await this.handle.rpc.request<ThreadGoalClearResponse>(
          'thread/goal/clear',
          { threadId: this.threadId } satisfies ThreadGoalClearParams,
        );
        this.emitGoalClearedConfig();
        return response;
      }

      default:
        throw new Error(`Unsupported Codex control request subtype: ${subtype}`);
    }
  }

  async refreshGoalConfig(): Promise<void> {
    await this.refreshGoalConfigAndReturn();
  }

  async listSlashCommands(opts?: { cwd?: string; forceReload?: boolean }): Promise<SlashCommandInfo[]> {
    const response = await this.handle.rpc.request<SkillsListResponse>(
      'skills/list',
      {
        cwds: opts?.cwd ? [opts.cwd] : [],
        forceReload: opts?.forceReload === true,
      } satisfies SkillsListParams,
    );
    const skills = codexSkillsToSlashCommands(response, opts?.cwd)
      .filter((command) => !CODEX_BUILT_IN_SLASH_COMMANDS.some((builtin) => builtin.name === command.name));
    return [...CODEX_BUILT_IN_SLASH_COMMANDS, ...skills];
  }

  interrupt(): void {
    const turnId = this.currentTurnId;
    if (!turnId) return;
    void this.handle.rpc
      .request<unknown>(
        'turn/interrupt',
        { threadId: this.threadId, turnId } satisfies TurnInterruptParams,
      )
      .catch(() => {
        /* best-effort */
      });
    this.closeTurnAsInterrupted(turnId);
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.pendingTurns = [];
    this.unsubscribeSessionNotifications?.();
    this.unsubscribeSessionNotifications = null;
    this.unsubscribeTransportClose?.();
    this.unsubscribeTransportClose = null;
    this.closeTurnConsumersAsInterrupted();
    try {
      await this.cardBuilder.persistCards();
    } catch {
      // best-effort; shutdown should continue even if history persistence fails
    }
    try {
      await this.handle.shutdown();
    } catch {
      // best-effort
    }
    try {
      await this.cardBuilder.persistCards();
    } catch {
      // best-effort
    }
  }

  /** Run a single explicit turn end-to-end: cb.startNewTurn → cb.userMessage
   * → turn/start → wait for the session-routed turn consumer to settle. */
  async runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<void> {
    if (this.exited) return;
    if (this.running) {
      // Queue — only one turn at a time, preserving FIFO order.
      this.pendingTurns.push(makeQueuedUserPrompt(prompt, attachments));
      this.callbacks.onQueueStateChange?.(this.threadId);
      return;
    }
    this.running = true;
    try {
      await this.runTurnImpl(prompt, attachments);
      while (this.pendingTurns.length > 0 && !this.exited) {
        const next = this.pendingTurns.shift()!;
        this.callbacks.onQueueStateChange?.(this.threadId);
        await this.runTurnImpl(next.prompt, next.attachments);
      }
    } finally {
      this.running = false;
    }
  }

  async steerQueuedMessage(opts?: { interruptCurrentTurn?: boolean }): Promise<boolean> {
    if (this.pendingTurns.length === 0 || !this.currentTurnId) return false;
    if (opts?.interruptCurrentTurn) {
      this.interrupt();
      return true;
    }
    const queued = this.pendingTurns.shift()!;
    this.callbacks.onQueueStateChange?.(this.threadId);

    const steered = await this.steerCurrentTurn(
      queued.prompt,
      queued.attachments,
      this.currentTurnId,
      opts,
    );
    if (!steered) {
      this.pendingTurns.unshift(queued);
      this.callbacks.onQueueStateChange?.(this.threadId);
    }
    return steered;
  }

  /** Remove a single queued message by id. No-op (returns false) when the id is
   * no longer queued — e.g. it already advanced into the active turn. */
  deleteQueuedMessage(id: string): boolean {
    const index = this.pendingTurns.findIndex((q) => q.id === id);
    if (index === -1) return false;
    this.pendingTurns.splice(index, 1);
    this.callbacks.onQueueStateChange?.(this.threadId);
    return true;
  }

  private async steerOrQueue(
    prompt: string,
    attachments: readonly Attachment[] | undefined,
    expectedTurnId: string,
  ): Promise<void> {
    const steered = await this.steerCurrentTurn(prompt, attachments, expectedTurnId);
    if (steered) return;
    this.enqueueOrRunTurn(prompt, attachments);
  }

  private enqueueOrRunTurn(prompt: string, attachments?: readonly Attachment[]): void {
    if (this.exited) return;
    if (this.running || this.currentTurnId) {
      this.pendingTurns.push(makeQueuedUserPrompt(prompt, attachments));
      this.callbacks.onQueueStateChange?.(this.threadId);
      return;
    }
    void this.runTurn(prompt, attachments);
  }

  private async steerCurrentTurn(
    prompt: string,
    attachments: readonly Attachment[] | undefined,
    expectedTurnId: string,
    opts?: { interruptCurrentTurn?: boolean },
  ): Promise<boolean> {
    try {
      if (attachments && attachments.length > 0) {
        await persistAttachments(this.threadId, attachments);
      }
      console.log(`[codex-app] steer active turn session=${this.threadId.slice(0, 8)} turn=${expectedTurnId.slice(0, 8)}`);
      await this.handle.rpc.request<unknown>(
        'turn/steer',
        {
          threadId: this.threadId,
          input: attachmentsToCodexUserInput(prompt, attachments),
          expectedTurnId,
        } satisfies TurnSteerParams,
      );
      const userEvent = this.cardBuilder.userMessage(prompt, attachments);
      this.callbacks.emitCardEvent(userEvent);
      if (userEvent.type === 'add') {
        try {
          await this.cardBuilder.persistCard(userEvent.card);
        } catch {
          // best-effort; the end-of-turn persist will retry if this process lives
        }
      }

      if (opts?.interruptCurrentTurn) {
        try {
          await this.handle.rpc.request<unknown>(
            'turn/interrupt',
            { threadId: this.threadId, turnId: expectedTurnId } satisfies TurnInterruptParams,
          );
        } catch (err) {
          console.warn(
            `[codex-app] failed to interrupt steered turn session=${this.threadId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return true;
    } catch (err) {
      console.warn(
        `[codex-app] failed to steer active turn session=${this.threadId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async runTurnImpl(prompt: string, attachments?: readonly Attachment[]): Promise<void> {
    const cb = this.cardBuilder;
    cb.startNewTurn();
    if (attachments && attachments.length > 0) {
      await persistAttachments(this.threadId, attachments);
    }
    const userEvent = cb.userMessage(prompt, attachments);
    this.callbacks.emitCardEvent(userEvent);

    let turnId: string | null = null;
    // Drain queued runtime overrides for THIS turn. We commit() after
    // turn/start succeeds so a failed request leaves the store
    // untouched and the UI can retry.
    const drained = this.overrideStore.drain();
    try {
      const params: TurnStartParams = {
        threadId: this.threadId,
        input: attachmentsToCodexUserInput(prompt, attachments),
        ...drained,
      };
      this.startingRunTurn = true;
      this.prestartedRunTurnId = null;
      let response: TurnStartResponse;
      try {
        response = await this.handle.rpc.request<TurnStartResponse>('turn/start', params);
      } finally {
        this.startingRunTurn = false;
      }
      this.overrideStore.commit();
      turnId = response.turn.id;
      this.currentTurnId = turnId;
      cb.setCurrentTurnId(turnId);

      const prestartedTurnId = this.prestartedRunTurnId as string | null;
      if (prestartedTurnId && prestartedTurnId !== turnId) {
        console.warn(
          `[codex-app] turn/start response mismatch session=${this.threadId.slice(0, 8)} response=${turnId.slice(0, 8)} notification=${prestartedTurnId.slice(0, 8)}`,
        );
      }

      const result = await this.beginTurnConsumer(turnId, { managedByRunTurn: true }).result;
      void result; // settled; stream-end already emitted by adapter
    } catch (err) {
      // Adapter wasn't able to settle (e.g., turn/start itself failed).
      // Emit a synthetic failure stream-end matching the SDK behavior.
      const message = err instanceof Error ? err.message : String(err);
      this.callbacks.emitStreamEnd({
        sessionId: this.threadId,
        success: false,
        error: message,
      });
    } finally {
      this.startingRunTurn = false;
      const lifecycleTurnId = turnId ?? this.prestartedRunTurnId;
      this.prestartedRunTurnId = null;
      await this.finishTurnLifecycle(lifecycleTurnId);
    }
  }

  private async refreshGoalConfigAndReturn(): Promise<ThreadGoalGetResponse> {
    const response = await this.handle.rpc.request<ThreadGoalGetResponse>(
      'thread/goal/get',
      { threadId: this.threadId } satisfies ThreadGoalGetParams,
    );
    if (response.goal) {
      this.emitGoalConfig(response.goal);
    } else {
      this.emitGoalClearedConfig();
    }
    return response;
  }

  private goalSetParams(params?: Record<string, unknown>): ThreadGoalSetParams {
    const out: ThreadGoalSetParams = { threadId: this.threadId };
    const input = params ?? {};

    if ('objective' in input) {
      out.objective = normalizeGoalObjective(input.objective);
    }
    if ('status' in input) {
      out.status = normalizeGoalStatusOrNull(input.status);
    }
    if ('tokenBudget' in input) {
      out.tokenBudget = normalizeGoalTokenBudget(input.tokenBudget);
    }
    return out;
  }

  private beginTurnConsumer(
    turnId: string,
    opts: { managedByRunTurn: boolean },
  ): CodexTurnStreamConsumer {
    const existing = this.turnConsumers.get(turnId);
    if (existing) return existing;

    this.settledTurnIds.delete(turnId);
    const consumer = createCodexTurnStreamConsumer(
      this.cardBuilder,
      {
        sessionId: this.threadId,
        threadId: this.threadId,
        turnId,
        tokens: this.tokens,
      },
      this.callbacks,
    );
    this.turnConsumers.set(turnId, consumer);
    void consumer.result.then(() => {
      void this.handleTurnConsumerSettled(turnId, consumer, opts.managedByRunTurn).catch((err) => {
        console.warn(
          `[codex-app] failed to settle turn consumer session=${this.threadId.slice(0, 8)} turn=${turnId.slice(0, 8)} error=${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    return consumer;
  }

  private async handleTurnConsumerSettled(
    turnId: string,
    consumer: CodexTurnStreamConsumer,
    managedByRunTurn: boolean,
  ): Promise<void> {
    if (this.turnConsumers.get(turnId) === consumer) {
      this.turnConsumers.delete(turnId);
    }
    this.rememberSettledTurn(turnId);
    consumer.dispose();
    if (managedByRunTurn) return;

    await this.finishTurnLifecycle(turnId);
    this.drainPendingTurnsAfterObservedTurn();
  }

  private async finishTurnLifecycle(turnId: string | null): Promise<void> {
    const builderTurnId = this.cardBuilder.getCurrentTurnId();
    const shouldClearCards = !turnId || !builderTurnId || builderTurnId === turnId;
    if (!turnId || this.currentTurnId === turnId) {
      this.currentTurnId = null;
    }
    try {
      await this.cardBuilder.persistCards();
    } catch {
      // best-effort
    }
    if (shouldClearCards) {
      this.cardBuilder.clearCards();
    }
    this.callbacks.onTurnSettled?.(this.threadId);
  }

  private drainPendingTurnsAfterObservedTurn(): void {
    if (this.exited || this.running || this.currentTurnId || this.pendingTurns.length === 0) {
      return;
    }
    const next = this.pendingTurns.shift()!;
    this.callbacks.onQueueStateChange?.(this.threadId);
    void this.runTurn(next.prompt, next.attachments);
  }

  private closeTurnConsumersAsInterrupted(): void {
    for (const consumer of this.turnConsumers.values()) {
      consumer.closeAsInterrupted();
    }
  }

  private closeTurnAsInterrupted(turnId: string): void {
    const consumer = this.turnConsumers.get(turnId);
    if (consumer) {
      consumer.closeAsInterrupted();
      return;
    }

    this.callbacks.emitStreamEnd({
      sessionId: this.threadId,
      turnId,
      success: false,
      interrupted: true,
    });
    void this.finishTurnLifecycle(turnId);
  }

  private handleTransportClosed(): void {
    this.closeTurnConsumersAsInterrupted();
  }

  private rememberSettledTurn(turnId: string): void {
    this.settledTurnIds.add(turnId);
    if (this.settledTurnIds.size <= 100) return;
    const oldest = this.settledTurnIds.values().next().value;
    if (oldest) this.settledTurnIds.delete(oldest);
  }

  private handleSessionNotification(notification: { method: string; params: unknown }): void {
    try {
      this.observeTokenUsageNotification(notification);
      const turnId = this.ensureTurnConsumerForNotification(notification);
      this.dispatchTurnNotification(notification, turnId);

      switch (notification.method) {
        case 'thread/goal/updated': {
          const params = notification.params as ThreadGoalUpdatedNotification;
          if (params.threadId !== this.threadId) return;
          this.emitGoalConfig(params.goal);
          return;
        }
        case 'thread/goal/cleared': {
          const params = notification.params as ThreadGoalClearedNotification;
          if (params.threadId !== this.threadId) return;
          this.emitGoalClearedConfig();
          return;
        }
        default:
          return;
      }
    } catch (err) {
      console.warn(
        `[codex-app] failed to handle session notification method=${notification.method} session=${this.threadId.slice(0, 8)} params=${codexProtocolPreview(notification.params)} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private observeTokenUsageNotification(notification: { method: string; params: unknown }): void {
    if (notification.method !== 'thread/tokenUsage/updated') return;
    if (!notificationBelongsToThread(notification.params, this.threadId)) return;
    this.tokens.observe(notification.params as ThreadTokenUsageUpdatedNotification);
  }

  private ensureTurnConsumerForNotification(
    notification: { method: string; params: unknown },
  ): string | null {
    if (!notificationBelongsToThread(notification.params, this.threadId)) return null;
    const turnId = notificationTurnId(notification);
    if (!turnId) return null;
    if (this.settledTurnIds.has(turnId)) return turnId;

    const existing = this.turnConsumers.get(turnId);
    if (existing) return turnId;
    if (!shouldCreateTurnConsumerForNotification(notification.method)) return turnId;

    const managedByRunTurn = this.startingRunTurn || this.currentTurnId === turnId;
    if (this.startingRunTurn) {
      this.prestartedRunTurnId = turnId;
    }

    if (managedByRunTurn) {
      this.currentTurnId = turnId;
      this.cardBuilder.setCurrentTurnId(turnId);
    } else {
      this.cardBuilder.startNewTurn(turnId);
      this.currentTurnId = turnId;
      this.callbacks.onQueueStateChange?.(this.threadId);
    }

    this.beginTurnConsumer(turnId, { managedByRunTurn });
    return turnId;
  }

  private dispatchTurnNotification(
    notification: { method: string; params: unknown },
    turnId: string | null,
  ): void {
    if (!notificationBelongsToThread(notification.params, this.threadId)) return;
    if (turnId) {
      this.turnConsumers.get(turnId)?.dispatch(notification);
      return;
    }
    for (const consumer of this.turnConsumers.values()) {
      consumer.dispatch(notification);
    }
  }

  private emitGoalConfig(goal: ThreadGoal): void {
    this.callbacks.onSessionConfigPatch?.(this.threadId, codexGoalToConfigPatch(goal));
  }

  private emitGoalClearedConfig(): void {
    this.callbacks.onSessionConfigPatch?.(this.threadId, clearedGoalConfigPatch());
  }

  private async handleServerRequest(req: {
    id: number | string;
    method: string;
    params: unknown;
  }): Promise<unknown> {
    const requestIdStr = String(req.id);
    const pendingRequestId = codexServerRequestInputId(this.threadId, requestIdStr);
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const method = req.method as CodexApprovalMethod;
        const prompt = codexApprovalToPermissionPrompt(method, requestIdStr, req.params);
        const decision = await this.callbacks.handlePermissionRequest(this.threadId, {
          ...prompt,
          requestId: pendingRequestId,
        });
        return codexApprovalResponse(method, req.params, decision);
      }
      case 'item/tool/requestUserInput':
        return this.handleToolRequestUserInput(
          req.params as ToolRequestUserInputParams,
          pendingRequestId,
        );
      case 'mcpServer/elicitation/request':
        return this.handleMcpServerElicitation(
          req.params as McpServerElicitationRequestParams,
          pendingRequestId,
        );
      case 'item/tool/call':
        return unsupportedDynamicToolCallResponse(req.params as DynamicToolCallParams);
      case 'account/chatgptAuthTokens/refresh':
        return unsupportedChatgptAuthTokensRefresh(req.params as ChatgptAuthTokensRefreshParams);
      case 'attestation/generate':
        return unsupportedAttestationGenerate(req.params);
      default:
        // Unknown server request — refuse.
        console.warn(
          `[codex-app] unsupported server request method=${req.method} id=${requestIdStr} params=${codexProtocolPreview(req.params)}`,
        );
        throw new Error(`unsupported server request method: ${req.method}`);
    }
  }

  private async handleToolRequestUserInput(
    params: ToolRequestUserInputParams,
    requestId: string,
  ): Promise<ToolRequestUserInputResponse> {
    const questions = params.questions ?? [];
    const decision = await this.callbacks.handlePermissionRequest(this.threadId, {
      requestId,
      inputType: 'question',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: questions.map(codexToolQuestionToPromptQuestion),
      },
      toolUseId: params.itemId,
      title: questions[0]?.question ?? 'Codex needs input',
      message: questions.length > 1 ? 'Codex needs answers before it can continue.' : undefined,
      skipAutoApprove: true,
    });
    if (decision.action === 'deny') return { answers: {} };
    return codexToolAnswersFromResponse(questions, decision.response ?? '');
  }

  private async handleMcpServerElicitation(
    params: McpServerElicitationRequestParams,
    requestId: string,
  ): Promise<McpServerElicitationRequestResponse> {
    const toolUseId = `mcp-elicitation:${requestId}`;
    if (params.mode === 'url') {
      const decision = await this.callbacks.handlePermissionRequest(this.threadId, {
        requestId,
        inputType: 'permission',
        toolName: 'McpElicitation',
        toolInput: {
          serverName: params.serverName,
          mode: params.mode,
          url: params.url,
          elicitationId: params.elicitationId,
        },
        toolUseId,
        title: `Open MCP prompt from ${params.serverName}?`,
        message: `${params.message}\n\n${params.url}`,
        skipAutoApprove: true,
      });
      return {
        action: decision.action === 'deny' ? 'decline' : 'accept',
        content: null,
        _meta: params._meta ?? null,
      };
    }

    const fields = isMcpElicitationFormSchema(params.requestedSchema)
      ? mcpElicitationFields(params.requestedSchema)
      : [];
    const decision = await this.callbacks.handlePermissionRequest(this.threadId, {
      requestId,
      inputType: 'question',
      toolName: 'AskUserQuestion',
      toolInput: {
        serverName: params.serverName,
        mode: params.mode,
        message: params.message,
        questions: fields.map((field) => field.question),
      },
      toolUseId,
      title: params.message || `MCP prompt from ${params.serverName}`,
      message: `MCP server: ${params.serverName}`,
      skipAutoApprove: true,
    });
    if (decision.action === 'deny') {
      return { action: 'decline', content: null, _meta: params._meta ?? null };
    }
    return {
      action: 'accept',
      content: mcpElicitationContentFromResponse(fields, decision.response ?? ''),
      _meta: params._meta ?? null,
    };
  }
}

// ── helpers ──

function notificationBelongsToThread(params: unknown, threadId: string): boolean {
  if (typeof params !== 'object' || params === null) return true;
  const candidate = (params as { threadId?: unknown }).threadId;
  return typeof candidate !== 'string' || candidate === threadId;
}

function notificationTurnId(notification: { method: string; params: unknown }): string | null {
  switch (notification.method) {
    case 'turn/started': {
      const params = notification.params as TurnStartedNotification;
      return params.turn?.id ?? null;
    }
    case 'turn/completed': {
      const params = notification.params as TurnCompletedNotification;
      return params.turn?.id ?? null;
    }
    default: {
      if (typeof notification.params !== 'object' || notification.params === null) return null;
      const candidate = (notification.params as { turnId?: unknown }).turnId;
      return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
    }
  }
}

function shouldCreateTurnConsumerForNotification(method: string): boolean {
  switch (method) {
    case 'turn/started':
    case 'turn/completed':
    case 'turn/plan/updated':
    case 'item/started':
    case 'item/autoApprovalReview/started':
    case 'item/autoApprovalReview/completed':
    case 'item/completed':
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'item/mcpToolCall/progress':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/summaryPartAdded':
    case 'item/reasoning/textDelta':
    case 'model/rerouted':
    case 'model/verification':
    case 'error':
      return true;
    default:
      return false;
  }
}

interface PromptQuestion {
  id?: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isSecret?: boolean;
}

interface McpElicitationField {
  key: string;
  schema: McpElicitationPrimitiveSchema;
  question: PromptQuestion;
  options: Array<{ label: string; value: JsonValue }> | null;
  multiSelect: boolean;
}

function codexToolQuestionToPromptQuestion(question: ToolRequestUserInputQuestion): PromptQuestion {
  return {
    id: question.id,
    question: question.question,
    header: question.header || undefined,
    options: question.options?.map((option) => ({
      label: option.label,
      description: option.description || undefined,
    })),
    isSecret: question.isSecret || undefined,
  };
}

function codexToolAnswersFromResponse(
  questions: ToolRequestUserInputQuestion[],
  responseText: string,
): ToolRequestUserInputResponse {
  const parts = questions.length > 1 ? responseText.split('\n') : [responseText];
  const answers: ToolRequestUserInputResponse['answers'] = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (!question?.id) continue;
    const answer = (parts[i] ?? '').trim();
    answers[question.id] = { answers: answer ? [answer] : [] };
  }
  return { answers };
}

function mcpElicitationFields(schema: { properties: { [key in string]?: McpElicitationPrimitiveSchema } }): McpElicitationField[] {
  return Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const primitive = prop as McpElicitationPrimitiveSchema;
    const options = mcpOptionsForSchema(primitive);
    const multiSelect = primitiveType(primitive) === 'array';
    return {
      key,
      schema: primitive,
      options,
      multiSelect,
      question: {
        id: key,
        question: primitiveTitle(primitive) ?? key,
        header: key,
        options: options?.map((option) => ({
          label: option.label,
          description: typeof option.value === 'string' && option.value !== option.label
            ? option.value
            : undefined,
        })),
        multiSelect,
      },
    };
  });
}

function isMcpElicitationFormSchema(value: JsonValue | McpElicitationSchema): value is McpElicitationSchema {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const properties = (value as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties);
}

function mcpElicitationContentFromResponse(
  fields: McpElicitationField[],
  responseText: string,
): { [key in string]?: JsonValue } {
  const parts = fields.length > 1 ? responseText.split('\n') : [responseText];
  const content: { [key in string]?: JsonValue } = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const raw = (parts[i] ?? '').trim();
    content[field.key] = parseMcpElicitationValue(field, raw);
  }
  return content;
}

function parseMcpElicitationValue(field: McpElicitationField, raw: string): JsonValue {
  if (field.multiSelect) {
    const answers = raw ? raw.split(',').map((part) => part.trim()).filter(Boolean) : [];
    return answers.map((answer) => mcpOptionValue(field.options, answer));
  }

  const mapped = mcpOptionValue(field.options, raw);
  const type = primitiveType(field.schema);
  if (type === 'boolean') {
    if (/^(true|yes|y|1)$/i.test(String(mapped))) return true;
    if (/^(false|no|n|0)$/i.test(String(mapped))) return false;
    return Boolean(raw);
  }
  if (type === 'number' || type === 'integer') {
    const n = Number(mapped);
    return Number.isFinite(n) ? n : raw;
  }
  return mapped;
}

function mcpOptionValue(
  options: Array<{ label: string; value: JsonValue }> | null,
  answer: string,
): JsonValue {
  const match = options?.find((option) => option.label === answer || option.value === answer);
  return match ? match.value : answer;
}

function mcpOptionsForSchema(
  schema: McpElicitationPrimitiveSchema,
): Array<{ label: string; value: JsonValue }> | null {
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.oneOf)) {
    return record.oneOf.map((option) => constOption(option)).filter((option): option is { label: string; value: JsonValue } => !!option);
  }
  if (Array.isArray(record.enum)) {
    const names = Array.isArray(record.enumNames) ? record.enumNames : [];
    return record.enum.map((value, index) => ({
      label: typeof names[index] === 'string' ? names[index] : String(value),
      value: jsonPrimitive(value),
    }));
  }
  const items = record.items as Record<string, unknown> | undefined;
  if (items && Array.isArray(items.anyOf)) {
    return items.anyOf.map((option) => constOption(option)).filter((option): option is { label: string; value: JsonValue } => !!option);
  }
  if (items && Array.isArray(items.enum)) {
    return items.enum.map((value) => ({ label: String(value), value: jsonPrimitive(value) }));
  }
  if (record.type === 'boolean') {
    return [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ];
  }
  return null;
}

function constOption(value: unknown): { label: string; value: JsonValue } | null {
  if (typeof value !== 'object' || value === null) return null;
  const option = value as { const?: unknown; title?: unknown };
  if (option.const === undefined) return null;
  return {
    label: typeof option.title === 'string' ? option.title : String(option.const),
    value: jsonPrimitive(option.const),
  };
}

function jsonPrimitive(value: unknown): JsonValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return String(value);
}

function primitiveType(schema: McpElicitationPrimitiveSchema): string | undefined {
  return (schema as { type?: string }).type;
}

function primitiveTitle(schema: McpElicitationPrimitiveSchema): string | undefined {
  const title = (schema as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

function unsupportedDynamicToolCallResponse(params: DynamicToolCallParams): DynamicToolCallResponse {
  const toolName = params.namespace ? `${params.namespace}:${params.tool}` : params.tool;
  return {
    success: false,
    contentItems: [{
      type: 'inputText',
      text: `Dynamic tool calls are not supported by Quicksave: ${toolName}`,
    }],
  };
}

function unsupportedChatgptAuthTokensRefresh(params: ChatgptAuthTokensRefreshParams): never {
  throw new Error(
    `chatgptAuthTokens refresh is not supported by Quicksave (reason=${params.reason}). ` +
      'Use Codex managed ChatGPT login or API key auth.',
  );
}

function unsupportedAttestationGenerate(params: unknown): never {
  console.warn(
    `[codex-app] unsupported server request method=attestation/generate params=${codexProtocolPreview(params)}`,
  );
  throw new Error('attestation/generate is not supported by Quicksave');
}

function normalizeGoalObjective(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('goal objective must be a string');
  }
  const objective = value.trim();
  if (!objective) {
    throw new Error('goal objective must not be empty');
  }
  if (objective.length > 4000) {
    throw new Error('goal objective must be 4000 characters or fewer');
  }
  return objective;
}

function normalizeGoalStatusOrNull(value: unknown): ThreadGoalStatus | null {
  if (value === null) return null;
  if (typeof value === 'string' && isThreadGoalStatus(value)) return value;
  throw new Error(`goal status must be one of: ${THREAD_GOAL_STATUSES.join(', ')}`);
}

function normalizeGoalTokenBudget(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('goal tokenBudget must be a non-negative number');
  }
  return value;
}

const THREAD_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const satisfies readonly ThreadGoalStatus[];

function isThreadGoalStatus(value: string): value is ThreadGoalStatus {
  return (THREAD_GOAL_STATUSES as readonly string[]).includes(value);
}

function codexGoalToConfigPatch(goal: ThreadGoal): Record<string, ConfigValue> {
  return {
    codexGoalPresent: true,
    codexGoalObjective: goal.objective,
    codexGoalStatus: goal.status,
    codexGoalTokenBudget: goal.tokenBudget,
    codexGoalTokensUsed: goal.tokensUsed,
    codexGoalTimeUsedSeconds: goal.timeUsedSeconds,
    codexGoalCreatedAt: goal.createdAt,
    codexGoalUpdatedAt: goal.updatedAt,
  };
}

function clearedGoalConfigPatch(): Record<string, ConfigValue> {
  return {
    codexGoalPresent: false,
    codexGoalObjective: null,
    codexGoalStatus: null,
    codexGoalTokenBudget: null,
    codexGoalTokensUsed: null,
    codexGoalTimeUsedSeconds: null,
    codexGoalCreatedAt: null,
    codexGoalUpdatedAt: null,
  };
}

function codexAppServerInit() {
  return {
    clientInfo: {
      name: 'quicksave-agent',
      title: 'Quicksave Agent',
      version: '0.0.0',
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
      optOutNotificationMethods: null,
    },
  };
}

function spawnCodexNativeListAppServer(): Promise<AppServerHandle> {
  return spawnAppServer(codexAppServerInit());
}

function spawnCodexAppServer(opts: StartSessionOpts | ResumeSessionOpts): Promise<AppServerHandle> {
  return spawnAppServer(
    codexAppServerInit(),
    {
      extraArgs: buildCodexSandboxMcpConfigArgs({
        cwd: opts.cwd,
        sessionId: 'sessionId' in opts ? opts.sessionId : undefined,
        corrId: opts.mcpCorrId,
      }),
    },
  );
}

async function listCodexThreads(
  handle: AppServerHandle,
  cwd: string | undefined,
  archived: boolean,
): Promise<Thread[]> {
  const threads: Thread[] = [];
  let cursor: string | null = null;
  do {
    const params: ThreadListParams = {
      cursor,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cwd: cwd ?? null,
      archived,
    };
    const response = await handle.rpc.request<ThreadListResponse>('thread/list', params);
    threads.push(
      ...response.data.filter((thread) =>
        !thread.ephemeral &&
        thread.parentThreadId === null &&
        (!cwd || thread.cwd === cwd)
      ),
    );
    cursor = response.nextCursor;
  } while (cursor);
  return threads;
}

function codexThreadToNativeSession(thread: Thread, archived: boolean): NativeSessionSummary {
  return {
    sessionId: thread.id,
    cwd: thread.cwd,
    agent: 'codex',
    title: thread.name ?? undefined,
    firstPrompt: thread.preview || undefined,
    createdAt: codexSecondsToMs(thread.createdAt),
    lastInteractionAt: codexSecondsToMs(thread.updatedAt),
    gitBranch: thread.gitInfo?.branch ?? undefined,
    archived,
  };
}

function codexSecondsToMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

export function buildCodexSandboxMcpConfigArgs(opts: {
  cwd: string;
  sessionId?: string;
  corrId?: string;
}): string[] {
  const config = buildSandboxMcpServerConfig({
    ownDir: __aiDir,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    corrId: opts.corrId,
    includeSandboxBash: false,
  });
  return [
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.command=${toTomlString(config.command)}`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.args=${toTomlStringArray(config.args)}`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.default_tools_approval_mode="approve"`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.tools.UpdateSessionStatus.approval_mode="approve"`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.tools.DisplayMarkdownReport.approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.default_tools_approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.default_tools_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.destructive_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.open_world_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.tools.UpdateSessionStatus.approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.tools.DisplayMarkdownReport.approval_mode="approve"`,
  ];
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function toTomlStringArray(values: string[]): string {
  return `[${values.map(toTomlString).join(', ')}]`;
}

function seedOverrideStoreFromResponse(
  store: RuntimeOverrideStore,
  resp: ThreadStartResponse | ThreadResumeResponse,
): void {
  store.reseedFromServer({
    model: resp.model,
    serviceTier: resp.serviceTier,
    effort: resp.reasoningEffort ?? null,
    approvalPolicy: resp.approvalPolicy,
    sandboxPolicy: resp.sandbox,
    approvalsReviewer: resp.approvalsReviewer,
  });
}

export function codexSkillsToSlashCommands(
  response: SkillsListResponse,
  preferredCwd?: string,
): SlashCommandInfo[] {
  const entries = Array.isArray(response.data) ? response.data : [];
  const selectedEntries = preferredCwd
    ? entries.filter((entry) => entry.cwd === preferredCwd)
    : entries;
  const sourceEntries = selectedEntries.length > 0 ? selectedEntries : entries;
  const seen = new Set<string>();
  const commands: SlashCommandInfo[] = [];

  for (const entry of sourceEntries) {
    for (const skill of entry.skills ?? []) {
      if (!skill.enabled) continue;
      const name = normalizeSlashCommandName(skill.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const description = firstNonBlank(
        skill.interface?.shortDescription,
        skill.shortDescription,
        skill.description,
      );
      commands.push({
        name,
        ...(description ? { description } : {}),
        source: 'codex-skill',
      });
    }
  }

  return commands;
}

function normalizeSlashCommandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^\/+/, '');
  return name.length > 0 ? name : null;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function buildThreadStartParams(opts: StartSessionOpts): ThreadStartParams {
  const preset = normalizePermissionLevelForAgent('codex', opts.permissionLevel) as CodexPermissionPreset;
  const perm = mapCodexPresetToInitialThreadOpts(preset, opts.sandboxed);
  return {
    model: opts.model ?? null,
    modelProvider: null,
    serviceTier: opts.serviceTier ?? null,
    cwd: opts.cwd,
    approvalPolicy: perm.approvalPolicy,
    approvalsReviewer: perm.approvalsReviewer,
    sandbox: perm.sandbox,
    config: null,
    serviceName: null,
    baseInstructions: null,
    developerInstructions: opts.systemPrompt ?? null,
    personality: null,
    ephemeral: null,
    sessionStartSource: null,
    threadSource: null,
  };
}

export function buildThreadResumeParams(opts: ResumeSessionOpts): ThreadResumeParams {
  const preset = normalizePermissionLevelForAgent('codex', opts.permissionLevel) as CodexPermissionPreset;
  const perm = mapCodexPresetToInitialThreadOpts(preset, opts.sandboxed);
  return {
    threadId: opts.sessionId,
    model: opts.model ?? null,
    modelProvider: null,
    serviceTier: opts.serviceTier ?? null,
    cwd: opts.cwd,
    approvalPolicy: perm.approvalPolicy,
    approvalsReviewer: perm.approvalsReviewer,
    sandbox: perm.sandbox,
    config: null,
    baseInstructions: null,
    developerInstructions: opts.systemPrompt ?? null,
    personality: null,
  };
}

function perTurnOverridesFromOpts(
  opts: StartSessionOpts | ResumeSessionOpts,
  resolved: ThreadStartResponse | ThreadResumeResponse,
): RuntimeOverrides {
  // First-turn overrides: only set what was explicitly requested AND
  // differs from the resolved-thread state (so we don't redundantly
  // re-send fields the server already accepted from thread/start).
  const overrides: RuntimeOverrides = {};
  if (opts.reasoningEffort && opts.reasoningEffort !== resolved.reasoningEffort) {
    overrides.effort = normalizeEffort(opts.reasoningEffort);
  }
  if (opts.serviceTier !== undefined && opts.serviceTier !== resolved.serviceTier) {
    overrides.serviceTier = opts.serviceTier;
  }
  return overrides;
}

function normalizeEffort(value: string): ReasoningEffort {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'none':
      return value;
    default:
      return 'medium';
  }
}

export function attachmentsToCodexUserInput(
  prompt: string,
  attachments?: readonly Attachment[],
): UserInput[] {
  const input: UserInput[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind === 'image') {
      input.push({
        type: 'image',
        url: `data:${normalizeCodexImageMime(attachment.mimeType)};base64,${attachment.data}`,
      });
      continue;
    }
    if (attachment.kind === 'text') {
      input.push({
        type: 'text',
        text: `<<<file:${attachment.name}>>>\n${decodeBase64Utf8(attachment.data)}\n<<<end:${attachment.name}>>>`,
        text_elements: [],
      });
    }
  }
  if (prompt.length > 0 || input.length === 0) {
    input.push({ type: 'text', text: prompt, text_elements: [] });
  }
  return input;
}

function normalizeCodexImageMime(mimeType: string): string {
  const lowered = mimeType.toLowerCase();
  switch (lowered) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return lowered;
    default:
      return 'image/png';
  }
}

function decodeBase64Utf8(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Map Codex's permission preset to the v2 fields we send on
 * `thread/start` / `thread/resume`. Keeps the mapping in one place
 * so Phase 3's per-turn override pipeline can reuse it. */
function mapCodexPresetToInitialThreadOpts(
  preset: CodexPermissionPreset,
  sandboxed: boolean,
): {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
} {
  let approvalPolicy: AskForApproval = 'on-request';
  let sandbox: SandboxMode = 'workspace-write';
  const approvalsReviewer: ApprovalsReviewer = 'user';
  switch (preset) {
    case 'full-access':
      approvalPolicy = 'never';
      sandbox = 'danger-full-access';
      break;
    case 'read-only':
      approvalPolicy = 'on-request';
      sandbox = 'read-only';
      break;
    case 'auto-review':
      approvalPolicy = 'on-request';
      sandbox = 'workspace-write';
      return { approvalPolicy, sandbox: !sandboxed ? 'danger-full-access' : sandbox, approvalsReviewer: 'auto_review' };
    case 'default':
    default:
      approvalPolicy = 'on-request';
      sandbox = 'workspace-write';
      break;
  }
  if (!sandboxed && sandbox === 'workspace-write') sandbox = 'danger-full-access';
  return { approvalPolicy, sandbox, approvalsReviewer };
}

function loadCumulativeSeed(sessionId: string): CumulativeUsageSeed | undefined {
  const last = getEventStore().getLastTurn(sessionId);
  if (!last) return undefined;
  const inputTokens = last.cumulativeInputTokens ?? last.inputTokens;
  const outputTokens = last.cumulativeOutputTokens ?? last.outputTokens;
  const cachedInputTokens = last.cumulativeCachedInputTokens ?? 0;
  if (!inputTokens && !outputTokens && !cachedInputTokens) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens,
  };
}

// Re-export RpcClient for advanced users / tests bypassing the provider.
export type { CodexRpcClient } from './rpcClient.js';
