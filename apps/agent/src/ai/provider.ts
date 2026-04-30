// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, CardEvent, CardStreamEnd, ContextUsageBreakdown } from '@sumicom/quicksave-shared';
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
  sendUserMessage(prompt: string): void;
  interrupt(): void;
  kill(): void;
  readonly alive: boolean;
  /** Optional — ask the provider for a breakdown of current context window
   * usage. Only supported by the Claude Code CLI (via `get_context_usage`
   * control_request). Returns null on providers that don't support it. */
  getContextUsage?(): Promise<ContextUsageBreakdown | null>;
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
  cwd: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
  /** Per-session reasoning depth. Currently only the Codex provider honors
   *  this — it maps to the SDK's `modelReasoningEffort` (minimal/low/medium/
   *  high/xhigh). Claude providers ignore it (their depth is decided by the
   *  model variant, not a per-turn knob). */
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
}

export interface ResumeSessionOpts {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  bypassFlagPath?: string;
}

export interface CodingAgentProvider {
  readonly id: AgentId;
  readonly historyMode: ProviderHistoryMode;

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
}
