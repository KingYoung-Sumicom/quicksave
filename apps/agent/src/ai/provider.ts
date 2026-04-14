import type { AgentId, CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';

export type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';
export type ProviderHistoryMode = 'claude-jsonl' | 'memory';

/** Represents a running provider session. */
export interface ProviderSession {
  sendUserMessage(prompt: string): void;
  interrupt(): void;
  kill(): void;
  readonly alive: boolean;
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
