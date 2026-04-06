import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeSessionSummary,
  ClaudeHistoryMessage,
  ClaudeStreamEventType,
} from '@sumicom/quicksave-shared';

const TOOL_RESULT_TRUNCATE_LENGTH = 500;

export interface StreamEvent {
  eventType: ClaudeStreamEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
  isPartial?: boolean;
}

export interface StreamEndResult {
  success: boolean;
  error?: string;
  totalCostUsd?: number;
  tokenUsage?: { input: number; output: number };
}

export type StreamCallback = (event: StreamEvent) => void;
export type StreamEndCallback = (result: StreamEndResult) => void;

interface ActiveSession {
  sessionId: string;
  abortController: AbortController;
}

export class ClaudeCodeService {
  private activeSessions: Map<string, ActiveSession> = new Map();
  private openSessions: Set<string> = new Set();

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const sessions = await listSessions({ dir: cwd, limit: 50 });
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      createdAt: s.createdAt,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
    }));
  }

  async getMessages(
    sessionId: string,
    cwd: string,
    offset = 0,
    limit = 50
  ): Promise<{ messages: ClaudeHistoryMessage[]; total: number; hasMore: boolean }> {
    // Get all messages first to know total count
    const allMessages = await getSessionMessages(sessionId, { dir: cwd });
    const total = allMessages.length;

    // Apply pagination
    const sliced = allMessages.slice(offset, offset + limit);

    const messages: ClaudeHistoryMessage[] = sliced.map((msg, i) => {
      const role = msg.type as 'user' | 'assistant';
      let content = '';
      let toolName: string | undefined;
      let toolInput: string | undefined;
      let toolResult: string | undefined;
      let truncated = false;

      // Extract content from the raw message payload
      const rawMessage = msg.message as any;
      if (rawMessage?.content) {
        if (typeof rawMessage.content === 'string') {
          content = rawMessage.content;
        } else if (Array.isArray(rawMessage.content)) {
          const parts: string[] = [];
          for (const block of rawMessage.content) {
            if (block.type === 'text') {
              parts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolName = block.name;
              toolInput = JSON.stringify(block.input).slice(0, TOOL_RESULT_TRUNCATE_LENGTH);
            } else if (block.type === 'tool_result') {
              const resultStr = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              if (resultStr.length > TOOL_RESULT_TRUNCATE_LENGTH) {
                toolResult = resultStr.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]';
                truncated = true;
              } else {
                toolResult = resultStr;
              }
            }
          }
          content = parts.join('\n');
        }
      }

      return {
        index: offset + i,
        role,
        content,
        toolName,
        toolInput,
        toolResult,
        truncated,
      };
    });

    return {
      messages,
      total,
      hasMore: offset + limit < total,
    };
  }

  async startSession(opts: {
    prompt: string;
    cwd: string;
    onStream: StreamCallback;
    onEnd: StreamEndCallback;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
  }): Promise<string> {
    const abortController = new AbortController();

    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        abortController,
        allowedTools: opts.allowedTools ?? ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        settingSources: ['project'],
      },
    });

    let sessionId = '';

    // Run the streaming loop in the background
    this.consumeStream(q, abortController, opts.onStream, opts.onEnd, (id) => {
      sessionId = id;
      this.activeSessions.set(id, { sessionId: id, abortController });
    });

    // Wait briefly for session ID to be captured from init message
    await new Promise<void>((resolve) => {
      const check = () => {
        if (sessionId) return resolve();
        setTimeout(check, 50);
      };
      check();
    });

    return sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    onStream: StreamCallback;
    onEnd: StreamEndCallback;
  }): Promise<string> {
    const abortController = new AbortController();

    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        abortController,
        resume: opts.sessionId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        settingSources: ['project'],
      },
    });

    let actualSessionId = opts.sessionId;

    this.consumeStream(q, abortController, opts.onStream, opts.onEnd, (id) => {
      actualSessionId = id;
      if (id !== opts.sessionId) {
        // Resume bug: SDK created a new session instead
        opts.onStream({
          eventType: 'system',
          content: `Warning: SDK created new session ${id} instead of resuming ${opts.sessionId}`,
        });
      }
      this.activeSessions.set(id, { sessionId: id, abortController });
    });

    // Wait for session ID
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.activeSessions.has(actualSessionId)) return resolve();
        setTimeout(check, 50);
      };
      check();
    });

    return actualSessionId;
  }

  cancelSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    session.abortController.abort();
    this.activeSessions.delete(sessionId);
    return true;
  }

  openSession(sessionId: string): void {
    this.openSessions.add(sessionId);
  }

  closeSession(sessionId: string): boolean {
    const wasOpen = this.openSessions.delete(sessionId);
    // Also cancel if currently streaming
    if (this.activeSessions.has(sessionId)) {
      this.cancelSession(sessionId);
    }
    return wasOpen;
  }

  isStreaming(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.openSessions.has(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.openSessions.has(sessionId);
  }

  getActiveSessionCount(): number {
    return this.openSessions.size;
  }

  cleanup(): void {
    for (const [, session] of this.activeSessions) {
      session.abortController.abort();
    }
    this.activeSessions.clear();
    this.openSessions.clear();
  }

  private async consumeStream(
    q: AsyncGenerator<any, void>,
    abortController: AbortController,
    onStream: StreamCallback,
    onEnd: StreamEndCallback,
    onSessionId: (id: string) => void
  ): Promise<void> {
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let capturedSessionId: string | null = null;

    const flushText = () => {
      if (textBuffer) {
        onStream({ eventType: 'assistant_text', content: textBuffer });
        textBuffer = '';
      }
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
      }
    };

    const cleanupSession = () => {
      if (capturedSessionId) {
        this.activeSessions.delete(capturedSessionId);
      }
    };

    const bufferText = (text: string) => {
      textBuffer += text;
      if (!bufferTimer) {
        bufferTimer = setTimeout(flushText, 150);
      }
      // Flush if buffer gets large
      if (textBuffer.length > 2048) {
        flushText();
      }
    };

    try {
      for await (const message of q) {
        if (abortController.signal.aborted) break;

        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init') {
          capturedSessionId = message.session_id;
          console.log(`[stream] init session=${message.session_id}`);
          onSessionId(message.session_id);
          continue;
        }

        // Streaming partial events
        if (message.type === 'stream_event') {
          const event = message.event;
          if (event?.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              bufferText(delta.text);
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              // Tool input being streamed — skip, we'll get the full tool_use from assistant message
            }
          }
          continue;
        }

        // Complete assistant messages
        if (message.type === 'assistant') {
          flushText();
          const betaMessage = message.message;
          if (betaMessage?.content) {
            for (const block of betaMessage.content) {
              if (block.type === 'tool_use') {
                onStream({
                  eventType: 'tool_use',
                  content: '',
                  toolName: block.name,
                  toolInput: JSON.stringify(block.input),
                });
              }
            }
          }
          continue;
        }

        // User messages contain tool results
        if (message.type === 'user') {
          const userMsg = message.message;
          if (userMsg?.content && Array.isArray(userMsg.content)) {
            for (const block of userMsg.content) {
              if (block.type === 'tool_result') {
                const resultContent = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
                const truncated = resultContent.length > TOOL_RESULT_TRUNCATE_LENGTH
                  ? resultContent.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                  : resultContent;
                onStream({
                  eventType: 'tool_result',
                  content: truncated,
                });
              }
            }
          }
          continue;
        }

        // Final result
        if (message.type === 'result') {
          flushText();
          console.log(`[stream] result session=${capturedSessionId} subtype=${message.subtype} cost=$${message.total_cost_usd?.toFixed(4) ?? '?'}`);
          cleanupSession();
          onEnd({
            success: message.subtype === 'success',
            error: message.subtype !== 'success'
              ? (message.errors?.join('; ') || `Session ended: ${message.subtype}`)
              : undefined,
            totalCostUsd: message.total_cost_usd,
            tokenUsage: message.usage
              ? { input: message.usage.input_tokens, output: message.usage.output_tokens }
              : undefined,
          });
          return;
        }
      }

      // Stream ended without result message (abort or unexpected end)
      flushText();
      console.log(`[stream] ended without result session=${capturedSessionId} (abort or unexpected)`);
      cleanupSession();
      onEnd({ success: true });
    } catch (error) {
      flushText();
      console.error(`[stream] error session=${capturedSessionId}:`, error);
      cleanupSession();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      onEnd({ success: false, error: msg });
    }
  }
}
