import { EventEmitter } from 'events';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions,
  getSessionMessages,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSession } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeSessionSummary,
  ClaudeHistoryMessage,
  ClaudeStreamEventType,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
} from '@sumicom/quicksave-shared';
const TOOL_RESULT_TRUNCATE_LENGTH = 500;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface StreamEvent {
  sessionId: string;
  streamId: string;
  eventType: ClaudeStreamEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;        // Present on tool_use events
  toolResultForId?: string;  // Present on tool_result events
  isPartial?: boolean;
}

export interface StreamEndResult {
  sessionId: string;
  streamId: string;
  success: boolean;
  error?: string;
  totalCostUsd?: number;
  tokenUsage?: { input: number; output: number };
}

/**
 * Events emitted by ClaudeCodeService:
 *   'stream'       (event: StreamEvent)
 *   'stream:end'   (result: StreamEndResult)
 *   'user-input-request' (request: ClaudeUserInputRequestPayload)
 */

type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';

/** Tools auto-approved at each permission level (no user prompt).
 *  Read/Glob/Grep are always auto-approved at SDK level (allowedTools).
 *  Tools NOT listed here go through canUseTool → permission prompt.
 *
 *  Risk tiers:
 *  - Safe:     Edit, Write, NotebookEdit, TodoWrite, Agent, EnterWorktree, ExitWorktree
 *  - Network:  WebFetch, WebSearch
 *  - Execute:  Bash
 *  - Code/Control: Skill, ToolSearch, Config
 *  - Schedule: CronCreate, CronDelete (arbitrary scheduled execution)
 *  - Remote:   RemoteTrigger (triggers remote agents)
 *  - Workflow:  EnterPlanMode, ExitPlanMode (ExitPlanMode has its own interactive UI)
 */
const AUTO_APPROVE: Record<PermissionLevel, Set<string>> = {
  bypassPermissions: new Set([
    // Safe
    'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree',
    // Network
    'WebFetch', 'WebSearch',
    // Execute
    'Bash',
    // Code/Control
    'Skill', 'ToolSearch', 'Config',
    // Schedule + Remote
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
    // Workflow
    'EnterPlanMode', 'ExitPlanMode',
    // Background tasks
    'TaskOutput', 'TaskStop',
  ]),
  acceptEdits: new Set(['Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree']),
  default:     new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent']),
  plan:        new Set(),
};

interface PersistentSession {
  session: SDKSession;
  sessionId: string;
  cwd: string;
  streaming: boolean;
  cancelStreaming: (() => void) | null;
  permissionLevel: PermissionLevel;
}

/** Extract readable text from tool_result content (which may be a string or array of blocks). */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('\n');
  }
  return JSON.stringify(content);
}

// ─── Direct JSONL reader ──────────────────────────────────────────────────────
// getSessionMessages() from the SDK follows the parentUuid chain, which stops
// at each compact_boundary. Reading the file directly lets us surface all
// messages across every compaction epoch in a single flat list.
//
// Set to false to fall back to the SDK reader (only shows current epoch).
const READ_THROUGH_COMPACT_BOUNDARY = false;

function projectDirName(cwd: string): string {
  // Mirrors SDK logic: replace non-alphanumeric chars with '-'.
  // Paths under 200 chars use the raw replacement; longer ones get a hash
  // suffix — but that edge case is unlikely for normal project paths.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function jsonlPath(sessionId: string, cwd: string): string {
  return join(homedir(), '.claude', 'projects', projectDirName(cwd), `${sessionId}.jsonl`);
}

async function readAllJSONLMessages(sessionId: string, cwd: string): Promise<any[]> {
  const filePath = jsonlPath(sessionId, cwd);
  const entries: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        const t = obj.type;
        // Keep user/assistant turns and compact_boundary markers; skip progress/queue-op
        if (t === 'user' || t === 'assistant' || (t === 'system' && obj.subtype === 'compact_boundary')) {
          entries.push(obj);
        }
      } catch { /* malformed line — skip */ }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  return entries;
}

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;  // stored for re-send on reconnect
}

export class ClaudeCodeService extends EventEmitter {
  private sessions: Map<string, PersistentSession> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;

  constructor() {
    super();
  }

  /** Build and emit a session-updated event with current state. */
  private emitSessionUpdate(sessionId: string): void {
    const ps = this.sessions.get(sessionId);
    const hasPendingInput = Array.from(this.pendingInputRequests.values())
      .some((p) => p.request.sessionId === sessionId);
    this.emit('session-updated', {
      sessionId,
      isActive: !!ps,
      isStreaming: ps?.streaming ?? false,
      hasPendingInput,
    });
  }

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const sessions = await listSessions({ dir: cwd, limit: 50 });
    // Enrich with live state + detect pending from JSONL
    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map((p) => p.request.sessionId)
    );
    // Check JSONL for sessions not in memory (cold pending detection)
    const enriched = await Promise.all(sessions.map(async (s) => {
      const isActive = this.sessions.has(s.sessionId);
      const isStreaming = this.sessions.get(s.sessionId)?.streaming ?? false;
      let hasPendingInput = pendingSessionIds.has(s.sessionId);

      // If not already known as pending from memory, check JSONL tail
      if (!hasPendingInput) {
        hasPendingInput = await this.detectPendingFromJSONL(s.sessionId, cwd);
      }

      return {
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        createdAt: s.createdAt,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        isActive,
        isStreaming,
        hasPendingInput,
      };
    }));
    // Sort: pending first, then active, then by lastModified
    enriched.sort((a, b) => {
      if (a.hasPendingInput !== b.hasPendingInput) return a.hasPendingInput ? -1 : 1;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastModified - a.lastModified;
    });
    return enriched;
  }

  /**
   * Check if a session's last message in the SDK JSONL is an unanswered tool_use.
   * Reads only the last few messages to keep it fast.
   */
  private async detectPendingFromJSONL(sessionId: string, cwd: string): Promise<boolean> {
    try {
      const allMessages = READ_THROUGH_COMPACT_BOUNDARY
        ? await readAllJSONLMessages(sessionId, cwd)
        : await getSessionMessages(sessionId, { dir: cwd });
      if (allMessages.length === 0) return false;
      const last = allMessages[allMessages.length - 1] as any;
      // Last message is assistant with a tool_use block and no following user/tool_result
      if (last.type !== 'assistant') return false;
      const content = last.message?.content;
      if (!Array.isArray(content)) return false;
      return content.some((block: any) => block.type === 'tool_use');
    } catch {
      return false;
    }
  }

  async getMessages(
    sessionId: string,
    cwd: string,
    offset = 0,
    limit = 50
  ): Promise<{ messages: ClaudeHistoryMessage[]; total: number; hasMore: boolean }> {
    const allMessages = READ_THROUGH_COMPACT_BOUNDARY
      ? await readAllJSONLMessages(sessionId, cwd)
      : await getSessionMessages(sessionId, { dir: cwd });
    const total = allMessages.length;
    const tailStart = Math.max(0, total - offset - limit);
    const tailEnd = Math.max(0, total - offset);
    const sliced = allMessages.slice(tailStart, tailEnd);

    const messages: ClaudeHistoryMessage[] = sliced.flatMap((msg: any, i) => {
      // compact_boundary system entries — render as a divider
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        return [{
          index: tailStart + i,
          role: 'system' as const,
          content: 'Context compacted',
        }];
      }

      const role = msg.type as 'user' | 'assistant';
      const rawMessage = msg.message as any;
      const expanded: import('@sumicom/quicksave-shared').ClaudeHistoryMessage[] = [];

      if (rawMessage?.content) {
        if (typeof rawMessage.content === 'string') {
          expanded.push({ index: tailStart + i, role, content: rawMessage.content });
        } else if (Array.isArray(rawMessage.content)) {
          const textParts: string[] = [];
          for (const block of rawMessage.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              expanded.push({
                index: tailStart + i,
                role,
                content: '',
                toolName: block.name,
                toolInput: JSON.stringify(block.input),
                toolUseId: block.id,
              });
            } else if (block.type === 'tool_result') {
              const resultStr = extractToolResultText(block.content);
              const truncated = resultStr.length > TOOL_RESULT_TRUNCATE_LENGTH;
              expanded.push({
                index: tailStart + i,
                role,
                content: '',
                toolResult: truncated
                  ? resultStr.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                  : resultStr,
                toolResultForId: block.tool_use_id,
                truncated,
              });
            }
          }
          if (textParts.length > 0) {
            expanded.unshift({ index: tailStart + i, role, content: textParts.join('\n') });
          }
        }
      }

      if (expanded.length === 0) {
        expanded.push({ index: tailStart + i, role, content: '' });
      }
      return expanded;
    });

    return {
      messages,
      total,
      hasMore: tailStart > 0,
    };
  }

  /**
   * Create a V2 session with the given cwd.
   * V2 SDKSessionOptions doesn't expose `cwd`, so we temporarily change
   * process.cwd() around the synchronous createSession() call.
   */
  private createSessionWithCwd(
    cwd: string,
    sessionId: string | null,
    opts: {
      allowedTools?: string[];
      model?: string;
      permissionMode?: string;
      resumeSessionId?: string;
    }
  ): SDKSession {
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      // allowedTools = SDK auto-approve list (bypasses canUseTool entirely).
      // Only list tools that should NEVER prompt at ANY permission level.
      // Everything else goes through permissionMode → canUseTool for dynamic control.
      const sessionOpts = {
        model: opts.model ?? DEFAULT_MODEL,
        allowedTools: opts.allowedTools ?? ['Read', 'Glob', 'Grep'],
        permissionMode: 'default' as const,
        settingSources: ['user' as const, 'project' as const, 'local' as const],
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          options: { title?: string; description?: string; displayName?: string; toolUseID: string; signal: AbortSignal }
        ) => {


          const resolvedSessionId = sessionId ?? 'unknown';

          // Check runtime permission level — auto-approve if tool is in the allow set
          const ps = resolvedSessionId !== 'unknown' ? this.sessions.get(resolvedSessionId) : undefined;
          const level = ps?.permissionLevel ?? 'acceptEdits';
          if (AUTO_APPROVE[level].has(toolName)) {

            return { behavior: 'allow' as const, updatedInput: input };
          }
          const requestId = `perm-${++this.requestCounter}`;

          // AskUserQuestion: forward as question type with options
          const isQuestion = toolName === 'AskUserQuestion';
          const questions = isQuestion ? (input as any).questions : undefined;


          // Forward request to PWA
          const request: ClaudeUserInputRequestPayload = {
            sessionId: resolvedSessionId,
            requestId,
            inputType: isQuestion ? 'question' : 'permission',
            title: isQuestion
              ? questions?.[0]?.question ?? 'Question from Claude'
              : (options.title ?? `Allow ${toolName}?`),
            message: isQuestion
              ? undefined
              : (options.description ?? JSON.stringify(input).slice(0, 500)),
            toolName,
            toolInput: input,
            // Include structured options for question type
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

          this.emit('user-input-request', request);
          this.emitSessionUpdate(resolvedSessionId);

          // Wait for explicit user response (no timeout — user must act)
          const response = await this.waitForUserInput(requestId, request, options.signal);
          if (response.action === 'deny') {
            return { behavior: 'deny' as const, message: 'User denied permission' };
          }

          // For AskUserQuestion, inject user's answer into the tool input
          if (isQuestion && response.response) {
            const answers: Record<string, string> = {};
            if (questions?.[0]?.question) {
              answers[questions[0].question] = response.response;
            }
            return {
              behavior: 'allow' as const,
              updatedInput: { ...input, answers },
            };
          }

          return { behavior: 'allow' as const, updatedInput: input };
        },
      };
      if (opts.resumeSessionId) {
        return unstable_v2_resumeSession(opts.resumeSessionId, sessionOpts);
      }
      return unstable_v2_createSession(sessionOpts);
    } finally {
      process.chdir(originalCwd);
    }
  }

  private waitForUserInput(
    requestId: string,
    request: ClaudeUserInputRequestPayload,
    signal?: AbortSignal
  ): Promise<ClaudeUserInputResponsePayload> {
    return new Promise((resolve) => {
      this.pendingInputRequests.set(requestId, { resolve, request });

      // Only auto-resolve if the SDK itself aborts (e.g. session closed)
      signal?.addEventListener('abort', () => {
        this.pendingInputRequests.delete(requestId);
        resolve({ sessionId: '', requestId, action: 'allow' });
      }, { once: true });
    });
  }

  /**
   * Called by message handler when PWA sends a user input response.
   */
  resolveUserInput(response: ClaudeUserInputResponsePayload): boolean {
    const pending = this.pendingInputRequests.get(response.requestId);
    if (!pending) return false;
    this.pendingInputRequests.delete(response.requestId);
    pending.resolve(response);
    this.emit('user-input-resolved', { requestId: response.requestId, sessionId: pending.request.sessionId });
    this.emitSessionUpdate(pending.request.sessionId);
    return true;
  }

  /**
   * Get all pending user input requests (for re-sending to a reconnected client).
   */
  getPendingInputRequests(): ClaudeUserInputRequestPayload[] {
    return Array.from(this.pendingInputRequests.values()).map((p) => p.request);
  }

  async startSession(opts: {
    prompt: string;
    cwd: string;
    streamId: string;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
  }): Promise<string> {
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
    const level: PermissionLevel = validModes.includes(opts.permissionMode as any)
      ? (opts.permissionMode as PermissionLevel) : 'acceptEdits';
    const session = this.createSessionWithCwd(opts.cwd, null, {
      allowedTools: opts.allowedTools,
      model: opts.model,
      permissionMode: opts.permissionMode,
    });

    const prompt = opts.systemPrompt
      ? `[System context: ${opts.systemPrompt}]\n\n${opts.prompt}`
      : opts.prompt;

    await session.send(prompt);
    this.emit('stream', {
      sessionId: '', streamId: opts.streamId,
      eventType: 'user_message' as ClaudeStreamEventType,
      content: opts.prompt,
    });

    const sessionId = await new Promise<string>((resolve) => {
      this.consumeStream(session, opts.streamId, (id) => {
        this.sessions.set(id, {
          session,
          sessionId: id,
          cwd: opts.cwd,
          streaming: true,
          cancelStreaming: null,
          permissionLevel: level,
        });
        this.emitSessionUpdate(id);
        resolve(id);
      });
    });

    return sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    streamId: string;
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);

    if (existing) {
      console.log(`[v2] hot resume session=${opts.sessionId}`);
      existing.streaming = true;
      this.emitSessionUpdate(opts.sessionId);
      this.emit('stream', {
        sessionId: opts.sessionId, streamId: opts.streamId,
        eventType: 'user_message' as ClaudeStreamEventType,
        content: opts.prompt,
      });
      await existing.session.send(opts.prompt);

      this.consumeStream(existing.session, opts.streamId, () => {
        // Session ID already captured
      });

      return opts.sessionId;
    }

    console.log(`[v2] cold resume session=${opts.sessionId}`);
    const session = this.createSessionWithCwd(opts.cwd, opts.sessionId, {
      resumeSessionId: opts.sessionId,
    });

    this.emit('stream', {
      sessionId: opts.sessionId, streamId: opts.streamId,
      eventType: 'user_message' as ClaudeStreamEventType,
      content: opts.prompt,
    });
    await session.send(opts.prompt);

    const actualSessionId = await new Promise<string>((resolve) => {
      this.consumeStream(session, opts.streamId, (id) => {
        if (id !== opts.sessionId) {
          this.emit('stream', {
            sessionId: id, streamId: opts.streamId,
            eventType: 'system',
            content: `Warning: SDK created new session ${id} instead of resuming ${opts.sessionId}`,
          });
        }
        this.sessions.set(id, {
          session,
          sessionId: id,
          cwd: opts.cwd,
          streaming: true,
          cancelStreaming: null,
          permissionLevel: 'acceptEdits' as PermissionLevel,
        });
        this.emitSessionUpdate(id);
        resolve(id);
      });
    });

    return actualSessionId;
  }

  cancelSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    // Stop streaming but keep the session process alive
    if (ps.cancelStreaming) {
      ps.cancelStreaming();
    }
    ps.streaming = false;
    return true;
  }

  setPermissionLevel(sessionId: string, level: PermissionLevel): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    ps.permissionLevel = level;

    this.emitSessionUpdate(sessionId);
    return true;
  }

  getPermissionLevel(sessionId: string): PermissionLevel {
    return this.sessions.get(sessionId)?.permissionLevel ?? 'acceptEdits';
  }

  closeSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    // Stop streaming if active
    if (ps.cancelStreaming) {
      ps.cancelStreaming();
    }
    // Terminate the subprocess
    ps.session.close();
    this.sessions.delete(sessionId);
    this.emitSessionUpdate(sessionId);
    return true;
  }

  isStreaming(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.streaming ?? false;
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  cleanup(): void {
    // Force-resolve any pending inputs on daemon shutdown
    for (const [requestId, pending] of this.pendingInputRequests) {
      pending.resolve({ sessionId: '', requestId, action: 'allow' });
    }
    this.pendingInputRequests.clear();

    for (const [, ps] of this.sessions) {
      try {
        ps.session.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sessions.clear();
  }

  private async consumeStream(
    session: SDKSession,
    streamId: string,
    onSessionId: (id: string) => void
  ): Promise<void> {
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let capturedSessionId: string | null = null;
    let cancelled = false;

    const emitStream = (event: Omit<StreamEvent, 'sessionId' | 'streamId'>) => {
      this.emit('stream', { ...event, sessionId: capturedSessionId ?? '', streamId });
    };

    const flushText = () => {
      if (textBuffer) {
        emitStream({ eventType: 'assistant_text', content: textBuffer });
        textBuffer = '';
      }
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
      }
    };

    const markStreamingDone = () => {
      if (capturedSessionId) {
        const ps = this.sessions.get(capturedSessionId);
        if (ps) {
          ps.streaming = false;
          ps.cancelStreaming = null;
        }
        this.emitSessionUpdate(capturedSessionId);
      }
    };

    const bufferText = (text: string) => {
      textBuffer += text;
      if (!bufferTimer) {
        bufferTimer = setTimeout(flushText, 150);
      }
      if (textBuffer.length > 2048) {
        flushText();
      }
    };

    // Wire up cancel function for this streaming turn
    const setCancelFn = () => {
      if (capturedSessionId) {
        const ps = this.sessions.get(capturedSessionId);
        if (ps) {
          ps.cancelStreaming = () => { cancelled = true; };
        }
      }
    };

    try {
      for await (const message of session.stream()) {
        if (cancelled) break;

        // Capture session ID from init message
        if (message.type === 'system' && (message as any).subtype === 'init') {
          capturedSessionId = message.session_id;
          console.log(`[stream] init session=${message.session_id}`);
          onSessionId(message.session_id);
          setCancelFn();
          continue;
        }

        // Session state changed — 'idle' means turn is over
        if (message.type === 'system' && (message as any).subtype === 'session_state_changed') {
          const state = (message as any).state;
          if (state === 'idle') {
            flushText();
            console.log(`[stream] session_state_changed=idle session=${capturedSessionId}`);
            // Don't call onEnd here — the result message will follow
          }
          continue;
        }

        // Streaming partial events
        if (message.type === 'stream_event') {
          const event = (message as any).event;
          if (event?.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              bufferText(delta.text);
            }
          }
          continue;
        }

        // Complete assistant messages
        if (message.type === 'assistant') {
          flushText();
          const betaMessage = (message as any).message;
          if (betaMessage?.content) {
            for (const block of betaMessage.content) {
              if (block.type === 'text' && block.text) {
                emitStream({
                  eventType: 'assistant_text',
                  content: block.text,
                });
              } else if (block.type === 'tool_use') {
                const toolInput = JSON.stringify(block.input);
                emitStream({
                  eventType: 'tool_use',
                  content: '',
                  toolName: block.name,
                  toolInput,
                  toolUseId: block.id,
                });
              }
            }
          }
          continue;
        }

        // User messages contain tool results
        if (message.type === 'user') {
          const userMsg = (message as any).message;
          if (userMsg?.content && Array.isArray(userMsg.content)) {
            for (const block of userMsg.content) {
              if (block.type === 'tool_result') {
                const resultContent = extractToolResultText(block.content);
                const truncated = resultContent.length > TOOL_RESULT_TRUNCATE_LENGTH
                  ? resultContent.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                  : resultContent;
                emitStream({
                  eventType: 'tool_result',
                  content: truncated,
                  toolResultForId: block.tool_use_id,
                });
              }
            }
          }
          continue;
        }

        // Final result — turn is complete but session stays alive
        if (message.type === 'result') {
          flushText();
          const result = message as any;
          console.log(`[stream] result session=${capturedSessionId} subtype=${result.subtype} cost=$${result.total_cost_usd?.toFixed(4) ?? '?'}`);
          markStreamingDone();
          this.emit('stream:end', {
            sessionId: capturedSessionId ?? '', streamId,
            success: result.subtype === 'success',
            error: result.subtype !== 'success'
              ? (result.errors?.join('; ') || `Session ended: ${result.subtype}`)
              : undefined,
            totalCostUsd: result.total_cost_usd,
            tokenUsage: result.usage
              ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
              : undefined,
          });
          return;
        }
      }

      flushText();
      console.log(`[stream] ended without result session=${capturedSessionId} (cancel or unexpected)`);
      markStreamingDone();
      this.emit('stream:end', { sessionId: capturedSessionId ?? '', streamId, success: true });
    } catch (error) {
      flushText();
      console.error(`[stream] error session=${capturedSessionId}:`, error);
      markStreamingDone();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.emit('stream:end', { sessionId: capturedSessionId ?? '', streamId, success: false, error: msg });
    }
  }
}
