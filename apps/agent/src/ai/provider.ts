import type { AgentId, CardEvent, CardStreamEnd, ContextUsageBreakdown } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';

export type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan' | 'auto';
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
  streamId: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
}

export interface ResumeSessionOpts {
  sessionId: string;
  prompt: string;
  cwd: string;
  streamId: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
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
