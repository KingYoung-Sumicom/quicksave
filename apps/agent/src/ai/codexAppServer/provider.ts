import type { AgentId } from '@sumicom/quicksave-shared';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StreamCardBuilder } from '../cardBuilder.js';
import { buildSandboxMcpServerConfig, SANDBOX_MCP_NAME } from '../sandboxMcp.js';
import type {
  CodexPermissionPreset,
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderHistoryMode,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from '../provider.js';
import { normalizePermissionLevelForAgent } from '../provider.js';
import { getEventStore } from '../../storage/eventStore.js';

import { consumeAppServerStream } from './cardAdapter.js';
import {
  codexApprovalResponse,
  codexApprovalToPermissionPrompt,
  type CodexApprovalMethod,
} from './approvalMapping.js';
import { spawnAppServer, type AppServerHandle } from './processManager.js';
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
import type { ApprovalsReviewer } from './schema/generated/v2/ApprovalsReviewer.js';
import type { ReasoningEffort } from './schema/generated/ReasoningEffort.js';

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

    void session.runTurn(opts.prompt, opts.streamId);

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
    void session.runTurn(opts.prompt, opts.streamId);

    return { sessionId: response.thread.id, session };
  }
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

class CodexAppServerSession implements CodexAppServerProviderSession {
  private readonly handle: AppServerHandle;
  private readonly tokens: TokenAccounting;
  private readonly overrideStore: RuntimeOverrideStore;
  private readonly threadId: string;
  private readonly cardBuilder: StreamCardBuilder;
  private readonly callbacks: ProviderCallbacks;
  private currentTurnId: string | null = null;
  private pendingPrompt: { text: string; streamId: string } | null = null;
  private running = false;
  private exited = false;
  /** Queue of streamIds SessionManager pushes ahead of `sendUserMessage` so
   *  hot-resume turns emit cards under the streamId the PWA is watching.
   *  Without this, the next turn would mint a synthetic `s_${Date.now()}`
   *  and `applySessionCards` would silently drop every card-event whose
   *  streamId isn't in the PWA's activeStreamIds. Field name + array shape
   *  match the contract SessionManager duck-types via `(ps as any).pendingStreamIds`. */
  public pendingStreamIds: string[] = [];

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

  sendUserMessage(prompt: string): void {
    // Hot-resume path: SessionManager pushes the resume's streamId into
    // pendingStreamIds before calling us, so the next turn's cards carry
    // the streamId the PWA's activeStreamIds list expects. The Date.now()
    // fallback is only for callers that bypass SessionManager (smoke
    // scripts, tests).
    const streamId = this.pendingStreamIds.shift() ?? `s_${Date.now()}`;
    void this.runTurn(prompt, streamId);
  }

  enqueueRuntimeOverride(patch: RuntimeOverrides): void {
    this.overrideStore.enqueue(patch);
  }

  hasPendingOverride(): boolean {
    return this.overrideStore.hasPending();
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

  kill(): void {
    void this.handle.shutdown();
  }

  /** Run a single turn end-to-end: cb.startNewTurn → cb.userMessage →
   * turn/start → consume notifications → emit stream-end. */
  async runTurn(prompt: string, streamId: string): Promise<void> {
    if (this.exited) return;
    if (this.running) {
      // Queue — only one turn at a time. Replace any pending prompt
      // with the latest (matches SDK provider behavior).
      this.pendingPrompt = { text: prompt, streamId };
      return;
    }
    this.running = true;
    try {
      await this.runTurnImpl(prompt, streamId);
      while (this.pendingPrompt && !this.exited) {
        const next = this.pendingPrompt;
        this.pendingPrompt = null;
        await this.runTurnImpl(next.text, next.streamId);
      }
    } finally {
      this.running = false;
    }
  }

  private async runTurnImpl(prompt: string, streamId: string): Promise<void> {
    const cb = this.cardBuilder;
    cb.startNewTurn(streamId);
    const userEvent = cb.userMessage(prompt);
    this.callbacks.emitCardEvent(userEvent);

    let turnId: string | null = null;
    // Drain queued runtime overrides for THIS turn. We commit() after
    // turn/start succeeds so a failed request leaves the store
    // untouched and the UI can retry.
    const drained = this.overrideStore.drain();
    try {
      const params: TurnStartParams = {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...drained,
      };
      const response = await this.handle.rpc.request<TurnStartResponse>('turn/start', params);
      this.overrideStore.commit();
      turnId = response.turn.id;
      this.currentTurnId = turnId;

      const result = await consumeAppServerStream(
        this.handle.rpc,
        cb,
        {
          sessionId: this.threadId,
          streamId,
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
        streamId,
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
      capabilities: { experimentalApi: false, optOutNotificationMethods: null },
    },
    {
      extraArgs: buildCodexSandboxMcpConfigArgs({
        cwd: opts.cwd,
        sessionId: 'sessionId' in opts ? opts.sessionId : undefined,
      }),
    },
  );
}

export function buildCodexSandboxMcpConfigArgs(opts: {
  cwd: string;
  sessionId?: string;
}): string[] {
  const config = buildSandboxMcpServerConfig({
    ownDir: __aiDir,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
  });
  return [
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.command=${toTomlString(config.command)}`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.args=${toTomlStringArray(config.args)}`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.default_tools_approval_mode="approve"`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.tools.SandboxBash.approval_mode="approve"`,
    '-c',
    `mcp_servers.${SANDBOX_MCP_NAME}.tools.UpdateSessionStatus.approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.default_tools_approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.default_tools_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.destructive_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.open_world_enabled=true`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.tools.SandboxBash.approval_mode="approve"`,
    '-c',
    `apps.${SANDBOX_MCP_NAME}.tools.UpdateSessionStatus.approval_mode="approve"`,
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

function buildThreadStartParams(opts: StartSessionOpts): ThreadStartParams {
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
    persistExtendedHistory: false,
  };
}

function buildThreadResumeParams(opts: ResumeSessionOpts): ThreadResumeParams {
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
    persistExtendedHistory: false,
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
