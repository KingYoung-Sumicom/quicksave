import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CardStreamEnd } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from './provider.js';

type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface QueuedTurn {
  prompt: string;
  initial: boolean;
  model?: string;
  cwd?: string;
  developerInstructions?: string;
}

interface ActiveTurn extends QueuedTurn {
  ended: boolean;
  sawAssistantOutput: boolean;
}

function safeJsonParse(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromUnknown(entry))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const maybeText = (value as Record<string, unknown>).text;
    if (typeof maybeText === 'string') return maybeText;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function emitAssistantMessage(cb: StreamCardBuilder, callbacks: ProviderCallbacks, text: string): void {
  if (!text.trim()) return;
  callbacks.emitCardEvent(cb.assistantText(text));
  const finalizeEvent = cb.finalizeAssistantText();
  if (finalizeEvent) {
    callbacks.emitCardEvent(finalizeEvent);
  }
}

function mapApprovalPolicy(level: StartSessionOpts['permissionLevel']): CodexApprovalPolicy {
  switch (level) {
    case 'bypassPermissions':
      return 'never';
    case 'acceptEdits':
      return 'on-request';
    case 'plan':
    case 'default':
    default:
      return 'untrusted';
  }
}

function mapSandboxMode(
  level: StartSessionOpts['permissionLevel'],
  sandboxed: boolean,
): CodexSandboxMode {
  if (level === 'plan') return 'read-only';
  if (sandboxed) return 'workspace-write';
  return 'danger-full-access';
}

function buildCodexDeveloperInstructions(opts: StartSessionOpts | ResumeSessionOpts): string | undefined {
  const parts: string[] = [];

  if (opts.permissionLevel === 'plan') {
    parts.push('Stay in planning mode. Do not modify files or run destructive commands unless the user explicitly changes modes.');
  }

  if (opts.systemPrompt) {
    parts.push(opts.systemPrompt);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

class CodexMcpSession implements ProviderSession {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly cardBuilder: StreamCardBuilder;
  private readonly callbacks: ProviderCallbacks;
  private readonly approvalPolicy: CodexApprovalPolicy;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly queue: QueuedTurn[] = [];
  private activeTurn: ActiveTurn | null = null;
  private running = false;
  private closed = false;
  private closeReason: 'interrupt' | 'kill' | null = null;
  private sessionIdPromiseResolve!: (sessionId: string) => void;
  private sessionIdPromiseReject!: (error: Error) => void;
  private readonly sessionIdPromise: Promise<string>;
  private sessionIdResolved = false;
  private threadId: string | null;

  constructor(args: {
    client: Client;
    transport: StdioClientTransport;
    cardBuilder: StreamCardBuilder;
    callbacks: ProviderCallbacks;
    approvalPolicy: CodexApprovalPolicy;
    sandboxMode: CodexSandboxMode;
    initialSessionId?: string;
  }) {
    this.client = args.client;
    this.transport = args.transport;
    this.cardBuilder = args.cardBuilder;
    this.callbacks = args.callbacks;
    this.approvalPolicy = args.approvalPolicy;
    this.sandboxMode = args.sandboxMode;
    this.threadId = args.initialSessionId ?? null;
    this.sessionIdPromise = new Promise<string>((resolve, reject) => {
      this.sessionIdPromiseResolve = resolve;
      this.sessionIdPromiseReject = reject;
    });

    if (this.threadId) {
      this.cardBuilder.updateSessionId(this.threadId);
      this.resolveSessionId(this.threadId);
    }
  }

  enqueueInitialTurn(turn: QueuedTurn): void {
    this.queue.push(turn);
    this.ensureRunLoop();
  }

  async waitForSessionId(): Promise<string> {
    return this.sessionIdPromise;
  }

  sendUserMessage(prompt: string): void {
    if (this.closed) return;
    this.queue.push({
      prompt,
      initial: false,
    });
    this.ensureRunLoop();
  }

  interrupt(): void {
    if (this.closed) return;
    this.closeReason = 'interrupt';
    void this.close();
  }

  kill(): void {
    if (this.closed) return;
    this.closeReason = 'kill';
    void this.close();
  }

  get alive(): boolean {
    return !this.closed && (this.running || this.queue.length > 0);
  }

  private ensureRunLoop(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.closed && this.queue.length > 0) {
        const queued = this.queue.shift()!;
        const turn: ActiveTurn = { ...queued, ended: false, sawAssistantOutput: false };
        this.activeTurn = turn;
        this.cardBuilder.startNewTurn();
        this.cardBuilder.userMessage(turn.prompt);

        try {
          const result = await this.client.callTool({
            name: turn.initial ? 'codex' : 'codex-reply',
            arguments: turn.initial
              ? {
                  prompt: turn.prompt,
                  cwd: turn.cwd,
                  sandbox: this.sandboxMode,
                  'approval-policy': this.approvalPolicy,
                  ...(turn.model ? { model: turn.model } : {}),
                  ...(turn.developerInstructions ? { 'developer-instructions': turn.developerInstructions } : {}),
                }
              : {
                  prompt: turn.prompt,
                  threadId: this.threadId,
                  ...(turn.developerInstructions ? { 'developer-instructions': turn.developerInstructions } : {}),
                },
          }) as any;

          const returnedThreadId = result?.structuredContent?.threadId
            ?? result?.threadId
            ?? result?.content?.threadId;
          if (typeof returnedThreadId === 'string') {
            this.resolveSessionId(returnedThreadId);
          }

          const contentText = result?.structuredContent?.content
            ?? result?.content?.content
            ?? result?.content;
          if (!turn.sawAssistantOutput && typeof contentText === 'string' && contentText.trim()) {
            emitAssistantMessage(this.cardBuilder, this.callbacks, contentText);
            turn.sawAssistantOutput = true;
          }

          this.endTurn(turn, {
            sessionId: this.threadId ?? returnedThreadId ?? '',
            success: true,
          });
          // Clear accumulated cards — memory-mode provider has no JSONL to snapshot
          this.cardBuilder.clearCards();
        } catch (error) {
          const sessionId = this.threadId ?? '';
          const interrupted = this.closeReason === 'interrupt';
          if (!this.sessionIdResolved) {
            this.sessionIdPromiseReject(error instanceof Error ? error : new Error(String(error)));
            this.sessionIdResolved = true;
          }
          if (!turn.ended && this.closeReason !== 'kill') {
            this.endTurn(turn, {
              sessionId,
              success: false,
              interrupted,
              error: interrupted
                ? undefined
                : (error instanceof Error ? error.message : 'Codex MCP request failed'),
            });
          }
          if (this.closeReason) break;
        } finally {
          this.activeTurn = null;
        }
      }
    } finally {
      this.running = false;
      await this.close();
    }
  }

  private resolveSessionId(sessionId: string): void {
    this.threadId = sessionId;
    this.cardBuilder.updateSessionId(sessionId);
    if (this.sessionIdResolved) return;
    this.sessionIdResolved = true;
    this.sessionIdPromiseResolve(sessionId);
  }

  private handleCodexEvent(note: any): void {
    const msg = note?.msg;
    if (!msg) return;

    const turn = this.activeTurn;
    if (!turn) {
      if (msg.type === 'session_configured' && typeof msg.session_id === 'string') {
        this.resolveSessionId(msg.session_id);
        if (typeof msg.model === 'string') {
          this.callbacks.onModelDetected(msg.model);
        }
      }
      return;
    }

    if (msg.type === 'session_configured' && typeof msg.session_id === 'string') {
      this.resolveSessionId(msg.session_id);
      if (typeof msg.model === 'string') {
        this.callbacks.onModelDetected(msg.model);
      }
      return;
    }

    if (msg.type === 'raw_response_item') {
      this.handleResponseItem(msg.item, turn);
      return;
    }

    if (msg.type === 'warning') {
      const warningText = typeof msg.message === 'string' ? msg.message : '';
      if (warningText) {
        this.callbacks.emitCardEvent(this.cardBuilder.systemMessage(warningText, 'warning'));
      }
      return;
    }

    if (msg.type === 'stream_error') {
      const errorText = typeof msg.message === 'string' ? msg.message : '';
      if (errorText && !errorText.startsWith('Reconnecting...')) {
        this.callbacks.emitCardEvent(this.cardBuilder.systemMessage(errorText, 'warning'));
      }
      return;
    }

    if (msg.type === 'turn_aborted') {
      this.endTurn(turn, {
        sessionId: this.threadId ?? '',
        success: false,
        interrupted: msg.reason === 'interrupted',
        error: msg.reason === 'interrupted' ? undefined : `Turn aborted: ${msg.reason ?? 'unknown'}`,
      });
    }
  }

  private handleResponseItem(item: any, turn: ActiveTurn): void {
    if (!item || typeof item !== 'object') return;

    if (item.type === 'message' && item.role === 'assistant') {
      const blocks = Array.isArray(item.content) ? item.content : [];
      const text = blocks
        .map((block: any) => {
          if (typeof block?.text === 'string') return block.text;
          if (typeof block?.content === 'string') return block.content;
          if (typeof block?.value === 'string') return block.value;
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
      if (text) {
        emitAssistantMessage(this.cardBuilder, this.callbacks, text);
        turn.sawAssistantOutput = true;
      }
      return;
    }

    if (item.type === 'reasoning') {
      const summaryText = Array.isArray(item.summary)
        ? item.summary.map((entry: any) => textFromUnknown(entry)).filter(Boolean).join('\n\n')
        : textFromUnknown(item.summary ?? item.text);
      if (summaryText.trim()) {
        this.callbacks.emitCardEvent(this.cardBuilder.thinkingBlock(summaryText));
      }
      return;
    }

    const itemType = typeof item.type === 'string' ? item.type : '';
    const looksLikeToolResult = itemType.endsWith('_result') || itemType.endsWith('_output');
    const looksLikeToolCall = !looksLikeToolResult
      && itemType !== 'message'
      && itemType !== 'reasoning'
      && (itemType.endsWith('_call') || itemType.endsWith('_tool_call') || itemType === 'function_call');

    if (looksLikeToolCall) {
      const toolUseId = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string'
          ? item.id
          : crypto.randomUUID();
      const toolName = typeof item.name === 'string'
        ? item.name
        : itemType;
      const toolInput = typeof item.arguments === 'string'
        ? (safeJsonParse(item.arguments) ?? { arguments: item.arguments })
        : (item.input && typeof item.input === 'object' && !Array.isArray(item.input))
          ? item.input as Record<string, unknown>
          : {};
      this.callbacks.emitCardEvent(this.cardBuilder.toolUse(toolName, toolInput, toolUseId));
      return;
    }

    if (looksLikeToolResult) {
      const parentToolUseId = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.tool_call_id === 'string'
          ? item.tool_call_id
          : undefined;
      if (!parentToolUseId) return;
      const resultText = textFromUnknown(item.output ?? item.result ?? item.content ?? item.text);
      const event = this.cardBuilder.toolResult(parentToolUseId, resultText, !!item.is_error);
      if (event) {
        this.callbacks.emitCardEvent(event);
      }
    }
  }

  private endTurn(turn: ActiveTurn, result: CardStreamEnd): void {
    if (turn.ended) return;
    turn.ended = true;
    this.callbacks.emitStreamEnd(result);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // Ignore shutdown errors.
    }
    try {
      await this.transport.close();
    } catch {
      // Ignore shutdown errors.
    }
  }

  bindNotifications(): void {
    this.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === 'codex/event') {
        this.handleCodexEvent(notification.params);
      }
    };
  }
}

export class CodexMcpProvider implements CodingAgentProvider {
  readonly id = 'codex' as const;
  readonly historyMode = 'memory' as const;

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const transport = new StdioClientTransport({
      command: 'codex',
      args: ['mcp-server'],
    });
    const client = new Client(
      { name: 'quicksave-codex-provider', version: '0.1.0' },
      { capabilities: { roots: { listChanged: false } } },
    );
    const session = new CodexMcpSession({
      client,
      transport,
      cardBuilder,
      callbacks,
      approvalPolicy: mapApprovalPolicy(opts.permissionLevel),
      sandboxMode: mapSandboxMode(opts.permissionLevel, opts.sandboxed),
    });
    session.bindNotifications();
    await client.connect(transport);
    session.enqueueInitialTurn({
      prompt: opts.prompt,
      initial: true,
      cwd: opts.cwd,
      model: opts.model && !opts.model.startsWith('claude-') ? opts.model : undefined,
      developerInstructions: buildCodexDeveloperInstructions(opts),
    });

    const sessionId = await session.waitForSessionId();
    return { sessionId, session };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const transport = new StdioClientTransport({
      command: 'codex',
      args: ['mcp-server'],
    });
    const client = new Client(
      { name: 'quicksave-codex-provider', version: '0.1.0' },
      { capabilities: { roots: { listChanged: false } } },
    );
    const session = new CodexMcpSession({
      client,
      transport,
      cardBuilder,
      callbacks,
      approvalPolicy: mapApprovalPolicy(opts.permissionLevel),
      sandboxMode: mapSandboxMode(opts.permissionLevel, opts.sandboxed),
      initialSessionId: opts.sessionId,
    });
    session.bindNotifications();
    await client.connect(transport);
    session.enqueueInitialTurn({
      prompt: opts.prompt,
      initial: false,
      developerInstructions: buildCodexDeveloperInstructions(opts),
    });
    return { sessionId: await session.waitForSessionId(), session };
  }
}
