// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, Attachment, CardEvent, CardStreamEnd, ContextUsageBreakdown, SessionQueueState, SlashCommandInfo } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';

export const CLAUDE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
] as const;

export const CODEX_PERMISSION_PRESETS = [
  'read-only',
  'default',
  'auto-review',
  'full-access',
] as const;

export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];
export type CodexPermissionPreset = typeof CODEX_PERMISSION_PRESETS[number];
export type PermissionLevel = ClaudePermissionMode | CodexPermissionPreset;

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

export function isCodexPermissionPreset(value: unknown): value is CodexPermissionPreset {
  return typeof value === 'string' && (CODEX_PERMISSION_PRESETS as readonly string[]).includes(value);
}

export function defaultPermissionLevelForAgent(agentId: AgentId): PermissionLevel {
  return agentId === 'codex' ? 'default' : 'acceptEdits';
}

export function isPermissionLevelAcceptedForAgent(agentId: AgentId, value: unknown): boolean {
  if (agentId === 'codex') {
    return isCodexPermissionPreset(value)
      || value === 'bypassPermissions'
      || value === 'plan'
      || value === 'auto'
      || value === 'acceptEdits';
  }
  return isClaudePermissionMode(value);
}

export function normalizePermissionLevelForAgent(
  agentId: AgentId,
  value: unknown,
): PermissionLevel {
  if (agentId === 'codex') {
    if (isCodexPermissionPreset(value)) return value;
    // Compatibility for sessions created before Codex had first-class presets.
    if (value === 'bypassPermissions') return 'full-access';
    if (value === 'plan') return 'read-only';
    if (value === 'auto') return 'auto-review';
    if (value === 'acceptEdits') return 'default';
    return defaultPermissionLevelForAgent(agentId);
  }

  if (isClaudePermissionMode(value)) return value;
  return defaultPermissionLevelForAgent(agentId);
}

export function isFullAccessPermission(agentId: AgentId, level: PermissionLevel): boolean {
  return agentId === 'codex'
    ? level === 'full-access'
    : level === 'bypassPermissions';
}

export type ProviderHistoryMode = 'claude-jsonl' | 'memory';

/** Represents a running provider session. */
export interface ProviderSession {
  sendUserMessage(prompt: string, attachments?: readonly Attachment[]): void;
  interruptThenSendUserMessage?(prompt: string, attachments?: readonly Attachment[]): void;
  interrupt(): void;
  kill(): void;
  readonly alive: boolean;
  /** Optional — `terminalManager` terminal id when this provider owns a PTY
   *  the PWA should render alongside the structured card stream. Only the
   *  `claude-terminal` provider sets this today. SessionManager copies it into
   *  the session config so the PWA can pick it up via the existing
   *  config-updated channel. */
  readonly terminalId?: string;
  /** Optional in-memory queue snapshot for provider sessions that serialize
   * user turns instead of accepting mid-turn input directly. */
  getQueueState?(): SessionQueueState | null;
  /** Optional — inject the provider's queued user message into the current
   * active turn instead of waiting for the next turn. */
  steerQueuedMessage?(opts?: { interruptCurrentTurn?: boolean }): Promise<boolean> | boolean;
  /** Optional — ask the provider for a breakdown of current context window
   * usage. Only supported by the Claude Code CLI (via `get_context_usage`
   * control_request). Returns null on providers that don't support it. */
  getContextUsage?(): Promise<ContextUsageBreakdown | null>;
  /** Optional — provider-specific slash-command suggestions for the composer. */
  listSlashCommands?(opts?: { cwd?: string; forceReload?: boolean }): Promise<SlashCommandInfo[]>;
  /** Optional — live-switch the auto-compact ceiling without respawning.
   * Only the Claude CLI provider implements it (sends a top-level
   * `update_environment_variables` stdin message; if `decoratedModel` is
   * provided, also fires `set_model` so the API's `[1m]` beta header flips
   * in sync). SDK / Codex providers omit this method, and SessionManager
   * falls back to cold-respawn-on-next-prompt for them. */
  updateContextWindow?(window: number, decoratedModel?: string): Promise<void>;
}

/** Callbacks the provider uses to communicate back to SessionManager. */
export interface ProviderCallbacks {
  emitCardEvent(event: CardEvent): void;
  emitStreamEnd(result: CardStreamEnd): void;
  handlePermissionRequest(
    sessionId: string,
    req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
  ): Promise<{
    action: 'allow' | 'deny';
    response?: string;
    updatedInput?: Record<string, unknown>;
  }>;
  /** Fired when a tool_use block is observed on the assistant stream. Runs for
   * EVERY tool invocation regardless of whether the permission callback fires.
   * CLI auto-mode silently pre-approves MCP tools without sending can_use_tool,
   * so daemon-side side effects (e.g. UpdateSessionStatus persistence) must be
   * driven from this hook, not handlePermissionRequest. */
  onToolUse?(sessionId: string, toolName: string, toolInput: Record<string, unknown>): void;
  /** Fired whenever the provider observes an SDK message whose `usage` indicates
   * a cache hit or write (`cache_creation_input_tokens > 0` or
   * `cache_read_input_tokens > 0`). Each fire effectively means "Anthropic just
   * touched the cache for this session", which is the precise event that
   * resets the 5-minute (or 1h) cache TTL on the server. SessionManager uses
   * this to anchor the PWA's countdown without waiting for the turn to end. */
  onCacheTouch?(sessionId: string): void;
  /** Fired when a provider's in-memory user-message queue changes. */
  onQueueStateChange?(sessionId: string): void;
  onModelDetected(model: string): void;
  /** Fired when the underlying provider process has fully exited. SessionManager
   * uses this to remove the session from its in-memory map and emit
   * `session-updated { isActive: false }` so the PWA's badge reflects reality.
   * The `providerSession` reference lets the manager ignore stale callbacks
   * from a provider that has already been replaced by cold resume. */
  onSessionExited?(sessionId: string, providerSession: ProviderSession): void;
}

export interface StartSessionOpts {
  prompt: string;
  /** Files / long-pasted text the user attached. Provider-side helpers
   *  (`attachmentsToContentBlocks`) convert these to Anthropic content blocks
   *  before pushing to Claude. */
  attachments?: readonly Attachment[];
  cwd: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
  /** Per-session reasoning depth. Codex maps it to the SDK's
   *  `modelReasoningEffort` (`minimal/low/medium/high/xhigh`). Claude maps it
   *  to the CLI's `--effort` flag / SDK's `Options.effort`
   *  (`low/medium/high/xhigh/max`). The two enums overlap but are NOT
   *  identical — keep the value as a string and let each provider validate
   *  its own range. */
  reasoningEffort?: string;
  /** Auto-compact ceiling for Claude Code (200k / 500k / 1M). Only the
   *  Claude CLI provider honors this — it sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
   *  on the spawn env and appends the `[1m]` model suffix when the value
   *  exceeds 200k (which enables the API's 1M context beta). Codex ignores. */
  contextWindow?: number;
  /** Absolute path to the daemon-owned sentinel file the CLI's PermissionRequest
   *  hook consults to auto-approve every tool. Presence of the file means bypass
   *  is active. Only ClaudeCliProvider uses it; other providers ignore it. */
  bypassFlagPath?: string;
  /** Correlation id minted by the daemon at spawn. Threaded into the sandbox
   *  MCP server's `--corr` so it can locate this session's registry entry
   *  before the real sessionId exists. See `sandboxMcp.ts` / `sandboxMcpStdio.ts`. */
  mcpCorrId?: string;
}

export interface ResumeSessionOpts {
  sessionId: string;
  prompt: string;
  /** Files / long-pasted text attached to the resume turn's prompt. */
  attachments?: readonly Attachment[];
  cwd: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  bypassFlagPath?: string;
  /** See {@link StartSessionOpts.mcpCorrId}. On resume the stdio server also
   *  gets `--session-id`, so this is belt-and-suspenders for cold re-spawns. */
  mcpCorrId?: string;
}

export const DEFAULT_AGENT_LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  'claude-terminal': 'Claude (Terminal)',
  'codex': 'Codex',
  'opencode': 'OpenCode',
  'pi': 'Pi',
};

export function getAgentLabel(agentId: AgentId): string {
  return DEFAULT_AGENT_LABELS[agentId] ?? agentId;
}

export interface AgentCapabilities {
  hasApiKey: boolean;
  hasCli: boolean;
  hasPlugin: boolean;
  supportsResume: boolean;
  supportsSandbox: boolean;
  supportsStreaming: boolean;
  /** Opt-in only: true when attachments are forwarded into the provider turn. */
  supportsAttachments?: true;
  /** Positive list of attachment kinds the provider forwards. */
  supportedAttachmentKinds?: Array<Attachment['kind']>;
}

export type ProbeResult = {
  version?: string;
  capabilities: AgentCapabilities;
  models?: Array<{ id: string; name: string }>;
};

export interface CodingAgentProvider {
  readonly id: AgentId;
  readonly historyMode: ProviderHistoryMode;
  /** Display name surfaced in handshake metadata and `agent:probe` responses.
   *  Optional so providers compile without metadata; the probe path falls
   *  back to {@link DEFAULT_AGENT_LABELS} when omitted. */
  readonly label?: string;

  startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;

  resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;

  /** Optional capability probe. Providers that omit it advertise only `id`
   *  and `label` in the `availableProviders` list (with zero capabilities). */
  probeProvider?(): Promise<ProbeResult>;
}
