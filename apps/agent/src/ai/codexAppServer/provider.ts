// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, Attachment, SlashCommandInfo } from '@sumicom/quicksave-shared';
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

import { consumeAppServerStream } from './cardAdapter.js';
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
import type { ThreadResumeParams } from './schema/generated/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './schema/generated/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from './schema/generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './schema/generated/v2/TurnStartResponse.js';
import type { TurnInterruptParams } from './schema/generated/v2/TurnInterruptParams.js';
import type { TurnSteerParams } from './schema/generated/v2/TurnSteerParams.js';
import type { ApprovalsReviewer } from './schema/generated/v2/ApprovalsReviewer.js';
import type { SkillsListParams } from './schema/generated/v2/SkillsListParams.js';
import type { SkillsListResponse } from './schema/generated/v2/SkillsListResponse.js';
import type { ReasoningEffort } from './schema/generated/ReasoningEffort.js';
import type { UserInput } from './schema/generated/v2/UserInput.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));
const __aiDir = dirname(__ownDir);

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

    overrideStore.enqueue(perTurnOverridesFromOpts(opts, response));
    scheduleInitialTurn(session, opts.prompt, opts.attachments);

    return { sessionId: response.thread.id, session };
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
  private exited = false;

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
    if (this.currentTurnId) {
      this.pendingTurns.push(makeQueuedUserPrompt(prompt, attachments));
      this.callbacks.onQueueStateChange?.(this.threadId);
      return;
    }
    void this.runTurn(prompt, attachments);
  }

  interruptThenSendUserMessage(prompt: string, attachments?: readonly Attachment[]): void {
    if (this.currentTurnId) this.interrupt();
    if (this.running) {
      this.pendingTurns.push(makeQueuedUserPrompt(prompt, attachments));
      this.callbacks.onQueueStateChange?.(this.threadId);
      return;
    }
    void this.runTurn(prompt, attachments);
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

  async listSlashCommands(opts?: { cwd?: string; forceReload?: boolean }): Promise<SlashCommandInfo[]> {
    const response = await this.handle.rpc.request<SkillsListResponse>(
      'skills/list',
      {
        cwds: opts?.cwd ? [opts.cwd] : [],
        forceReload: opts?.forceReload === true,
        perCwdExtraUserRoots: null,
      } satisfies SkillsListParams,
    );
    return codexSkillsToSlashCommands(response, opts?.cwd);
  }

  interrupt(): void {
    if (!this.currentTurnId) return;
    void this.handle.rpc
      .request<unknown>(
        'turn/interrupt',
        { threadId: this.threadId, turnId: this.currentTurnId } satisfies TurnInterruptParams,
      )
      .catch(() => {
        /* best-effort */
      });
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.pendingTurns = [];
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

  /** Run a single turn end-to-end: cb.startNewTurn → cb.userMessage →
   * turn/start → consume notifications → emit stream-end. */
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
      const response = await this.handle.rpc.request<TurnStartResponse>('turn/start', params);
      this.overrideStore.commit();
      turnId = response.turn.id;
      this.currentTurnId = turnId;
      cb.setCurrentTurnId(turnId);

      const result = await consumeAppServerStream(
        this.handle.rpc,
        cb,
        {
          sessionId: this.threadId,
          threadId: this.threadId,
          turnId,
          tokens: this.tokens,
        },
        this.callbacks,
      );
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
      this.currentTurnId = null;
      try {
        await cb.persistCards();
      } catch {
        // best-effort
      }
      cb.clearCards();
      this.callbacks.onTurnSettled?.(this.threadId);
    }
  }

  private async handleServerRequest(req: {
    id: number | string;
    method: string;
    params: unknown;
  }): Promise<unknown> {
    const requestIdStr = String(req.id);
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const method = req.method as CodexApprovalMethod;
        const prompt = codexApprovalToPermissionPrompt(method, requestIdStr, req.params);
        const decision = await this.callbacks.handlePermissionRequest(this.threadId, prompt);
        return codexApprovalResponse(method, req.params, decision);
      }
      default:
        // Unknown server request — refuse.
        throw new Error(`unsupported server request method: ${req.method}`);
    }
  }
}

// ── helpers ──

function spawnCodexAppServer(opts: StartSessionOpts | ResumeSessionOpts): Promise<AppServerHandle> {
  return spawnAppServer(
    {
      clientInfo: {
        name: 'quicksave-agent',
        title: 'Quicksave Agent',
        version: '0.0.0',
      },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    },
    {
      extraArgs: buildCodexSandboxMcpConfigArgs({
        cwd: opts.cwd,
        sessionId: 'sessionId' in opts ? opts.sessionId : undefined,
        corrId: opts.mcpCorrId,
      }),
    },
  );
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
    effort: resp.reasoningEffort ?? null,
    approvalPolicy: resp.approvalPolicy,
    sandboxPolicy: resp.sandbox,
    permissionProfile: resp.permissionProfile,
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
    serviceTier: null,
    cwd: opts.cwd,
    approvalPolicy: perm.approvalPolicy,
    approvalsReviewer: perm.approvalsReviewer,
    sandbox: perm.sandbox,
    permissionProfile: null,
    config: null,
    serviceName: null,
    baseInstructions: null,
    developerInstructions: opts.systemPrompt ?? null,
    personality: null,
    ephemeral: null,
    sessionStartSource: null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  };
}

export function buildThreadResumeParams(opts: ResumeSessionOpts): ThreadResumeParams {
  const preset = normalizePermissionLevelForAgent('codex', opts.permissionLevel) as CodexPermissionPreset;
  const perm = mapCodexPresetToInitialThreadOpts(preset, opts.sandboxed);
  return {
    threadId: opts.sessionId,
    history: null,
    path: null,
    model: opts.model ?? null,
    modelProvider: null,
    serviceTier: null,
    cwd: opts.cwd,
    approvalPolicy: perm.approvalPolicy,
    approvalsReviewer: perm.approvalsReviewer,
    sandbox: perm.sandbox,
    permissionProfile: null,
    config: null,
    baseInstructions: null,
    developerInstructions: opts.systemPrompt ?? null,
    personality: null,
    excludeTurns: true,
    persistExtendedHistory: true,
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
