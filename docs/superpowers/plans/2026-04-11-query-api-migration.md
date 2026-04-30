# Migrate ClaudeCodeService to query() Streaming Input API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v2 Session API (`createSession`/`resumeSession` + `send()`/`stream()`) with the `query()` streaming input API so sessions behave like VS Code Claude Code — persistent across prompts, queueable mid-stream, and interruptible.

**Architecture:** Each in-memory session holds a `Query` object (extends `AsyncGenerator` with `interrupt()`/`close()`) fed by an `AsyncQueue<SDKUserMessage>`. A single consumer loop runs for the session's entire lifetime, handling all turns. New prompts push to the queue; cancels call `query.interrupt()`; close calls `query.close()`.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (`query()`, `Query`, `SDKUserMessage`, `Options`), TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/agent/src/ai/asyncQueue.ts` | **Create** | Push-based `AsyncIterable<T>` utility for feeding prompts to `query()` |
| `apps/agent/src/ai/asyncQueue.test.ts` | **Create** | Unit tests for AsyncQueue |
| `apps/agent/src/ai/claudeCodeService.ts` | **Modify** | Replace `SDKSession` with `Query` + `AsyncQueue`, rewrite start/resume/cancel/close, simplify consumer loop |
| `docs/references/quicksave-architecture.en.md` | **Modify** | Update session lifecycle docs |

Tests that should NOT need changes (verify at end):
- `apps/agent/src/handlers/messageHandler.test.ts` — tests MessageHandler, not ClaudeCodeService internals
- `apps/agent/src/service/ipc.test.ts`
- All other existing tests

---

### Task 1: AsyncQueue utility

**Files:**
- Create: `apps/agent/src/ai/asyncQueue.ts`
- Create: `apps/agent/src/ai/asyncQueue.test.ts`

A push-based async iterable: `push(value)` enqueues, `end()` closes, consumers `for await` over it. This feeds user prompts into `query()`.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/src/ai/asyncQueue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './asyncQueue.js';

describe('AsyncQueue', () => {
  it('yields pushed values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('waits for values when consumed before pushed', async () => {
    const q = new AsyncQueue<string>();
    const results: string[] = [];

    const consumer = (async () => {
      for await (const v of q) {
        results.push(v);
      }
    })();

    // Push after consumer starts waiting
    q.push('a');
    q.push('b');
    q.end();
    await consumer;

    expect(results).toEqual(['a', 'b']);
  });

  it('stops iterating after end() is called', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored after end

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([1]);
  });

  it('supports multiple sequential consumers via Symbol.asyncIterator', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);

    const iter = q[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ value: 1, done: false });

    const second = await iter.next();
    expect(second).toEqual({ value: 2, done: false });

    q.end();
    const third = await iter.next();
    expect(third).toEqual({ value: undefined, done: true });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd apps/agent && npx vitest run src/ai/asyncQueue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AsyncQueue**

Create `apps/agent/src/ai/asyncQueue.ts`:

```ts
/**
 * Push-based async iterable.
 * Consumers `for await` over it; producers call `push()` to enqueue values
 * and `end()` to signal completion.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  /** Enqueue a value. No-op if end() was already called. */
  push(value: T): void {
    if (this.done) return;
    this.queue.push(value);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  /** Signal that no more values will be pushed. */
  end(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd apps/agent && npx vitest run src/ai/asyncQueue.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```
feat: add AsyncQueue utility for streaming input
```

---

### Task 2: Replace PersistentSession with Query-based session

**Files:**
- Modify: `apps/agent/src/ai/claudeCodeService.ts`

Replace the `SDKSession` + `send()`/`stream()` model with `Query` + `AsyncQueue`. This is the core change.

- [ ] **Step 1: Update imports**

Replace:
```ts
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSession } from '@anthropic-ai/claude-agent-sdk';
```

With:
```ts
import {
  query as sdkQuery,
  listSessions,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
} from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage, Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './asyncQueue.js';
```

- [ ] **Step 2: Rewrite PersistentSession interface**

Replace the entire `PersistentSession` interface:

```ts
interface PersistentSession {
  query: Query;
  inputQueue: AsyncQueue<SDKUserMessage>;
  sessionId: string;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  cardBuilder: StreamCardBuilder | null;
}
```

Removed fields:
- `session: SDKSession` → replaced by `query: Query` + `inputQueue: AsyncQueue`
- `sessionIdRef` → no longer needed; `query` handles session ID internally
- `cancelStreaming` → use `query.interrupt()`
- `_streamGenerator`, `_streamDone`, `_pendingStreamIds` → no longer needed; single consumer loop handles all turns

- [ ] **Step 3: Rewrite `createSessionWithCwd` → `buildQueryOptions`**

The old method created an `SDKSession`. The new method builds `SDKOptions` for `query()`. The `canUseTool` callback stays the same — it's passed via options to `query()`.

Replace `createSessionWithCwd` with:

```ts
private buildQueryOptions(
  cwd: string,
  sessionId: string | null,
  opts: {
    allowedTools?: string[];
    model?: string;
    permissionMode?: string;
    resumeSessionId?: string;
  }
): SDKOptions {
  return {
    cwd,
    model: opts.model ?? DEFAULT_MODEL,
    allowedTools: opts.allowedTools ?? ['Read', 'Glob', 'Grep'],
    permissionMode: 'default' as const,
    includePartialMessages: true,
    settingSources: ['user' as const, 'project' as const, 'local' as const],
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    canUseTool: async (toolName, input, options) => {
      // ── (exact same canUseTool body as current code) ──
      // The only change: instead of opts.sessionIdRef, use sessionId directly
      // since the query object manages the session lifecycle.
      const resolvedSessionId = sessionId ?? 'unknown';

      const ps = resolvedSessionId !== 'unknown' ? this.sessions.get(resolvedSessionId) : undefined;
      const level = ps?.permissionLevel ?? this.sessionPermissions.get(resolvedSessionId) ?? 'acceptEdits';
      if (AUTO_APPROVE[level].has(toolName)) {
        const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
        if (FILE_WRITE_TOOLS.has(toolName)) {
          const filePath = (input.file_path ?? input.path) as string | undefined;
          if (filePath) {
            const resolvedFile = resolve(filePath);
            const resolvedCwd = resolve(cwd);
            const inScope = resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + '/');
            if (!inScope) { /* fall through */ } else {
              return { behavior: 'allow' as const, updatedInput: input };
            }
          } else {
            return { behavior: 'allow' as const, updatedInput: input };
          }
        } else {
          return { behavior: 'allow' as const, updatedInput: input };
        }
      }

      // ── permission prompt logic (unchanged from current code) ──
      const requestId = `perm-${++this.requestCounter}`;
      const isQuestion = toolName === 'AskUserQuestion';
      const questions = isQuestion ? (input as any).questions : undefined;

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
        toolUseId: options.toolUseID,
        ...(options.agentID ? { agentId: options.agentID } : {}),
        ...(isQuestion && questions ? {
          options: questions.flatMap((q: any) =>
            (q.options ?? []).map((opt: any) => ({
              key: opt.label, label: opt.label, description: opt.description,
            }))
          ),
        } : {}),
      };

      const builder = ps?.cardBuilder;
      if (builder) {
        const pendingAttachment = {
          sessionId: resolvedSessionId, requestId,
          inputType: request.inputType, title: request.title,
          message: request.message, options: request.options,
        };
        const ephemeral = !!options.agentID;
        const cardEvt = builder.toolCallFromPermission(toolName, input, options.toolUseID, pendingAttachment, ephemeral);
        this.emit('card-event', cardEvt);
      }

      this.emit('user-input-request', request);
      this.emitSessionUpdate(resolvedSessionId);

      const response = await this.waitForUserInput(requestId, request, options.signal);
      if (response.action === 'deny') {
        return { behavior: 'deny' as const, message: 'User denied permission' };
      }
      if (isQuestion && response.response) {
        const answers: Record<string, string> = {};
        if (questions?.[0]?.question) answers[questions[0].question] = response.response;
        return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
      }
      return { behavior: 'allow' as const, updatedInput: input };
    },
  };
}
```

**Key difference from old code:** No more `sessionIdRef` / deferred promise dance. The `sessionId` is known before `canUseTool` fires because:
- For `startSession`: we capture it from the `init` message before any tools run
- For `resumeSession`: it's the input parameter

The `sessionId` variable in the closure is mutable (`let`) and updated when `init` arrives.

- [ ] **Step 4: Rewrite `startSession`**

```ts
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

  const inputQueue = new AsyncQueue<SDKUserMessage>();

  // Push initial prompt
  const prompt = opts.systemPrompt
    ? `[System context: ${opts.systemPrompt}]\n\n${opts.prompt}`
    : opts.prompt;
  inputQueue.push({
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  });

  // sessionId is captured from the init message — mutable closure for canUseTool
  let sessionId: string | null = null;

  const queryOpts = this.buildQueryOptions(opts.cwd, null, {
    allowedTools: opts.allowedTools,
    model: opts.model,
    permissionMode: opts.permissionMode,
  });
  const q = sdkQuery({ prompt: inputQueue, options: queryOpts });

  // Wait for init to capture sessionId, then register the session
  const initPromise = new Promise<string>((resolve) => {
    this.consumeQueryStream(q, inputQueue, opts.streamId, opts.cwd, level, (id) => {
      sessionId = id;
      this.sessionPermissions.set(id, level);
      resolve(id);
    });
  });

  return initPromise;
}
```

- [ ] **Step 5: Rewrite `resumeSession`**

```ts
async resumeSession(opts: {
  sessionId: string;
  prompt: string;
  cwd: string;
  streamId: string;
}): Promise<string> {
  const existing = this.sessions.get(opts.sessionId);

  if (existing) {
    // Hot resume — just push to the queue. The existing consumer handles it.
    console.log(`[v2] hot resume (enqueue) session=${opts.sessionId}`);
    existing.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    });
    // If not currently streaming, the consumer loop picks up the new message
    // on its next iteration. If streaming, the SDK queues it after the current turn.
    return opts.sessionId;
  }

  // Cold resume — create a new query with resume option
  console.log(`[v2] cold resume session=${opts.sessionId}`);
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  inputQueue.push({
    type: 'user',
    message: { role: 'user', content: opts.prompt },
    parent_tool_use_id: null,
  });

  let capturedId = opts.sessionId;
  const restoredLevel = this.sessionPermissions.get(opts.sessionId) ?? 'acceptEdits' as PermissionLevel;

  const queryOpts = this.buildQueryOptions(opts.cwd, opts.sessionId, {
    resumeSessionId: opts.sessionId,
  });
  const q = sdkQuery({ prompt: inputQueue, options: queryOpts });

  const initPromise = new Promise<string>((resolve) => {
    this.consumeQueryStream(q, inputQueue, opts.streamId, opts.cwd, restoredLevel, (id) => {
      if (id !== opts.sessionId) {
        console.warn(`[v2] SDK created new session ${id} instead of resuming ${opts.sessionId}`);
      }
      capturedId = id;
      this.sessionPermissions.set(id, restoredLevel);
      resolve(id);
    });
  });

  return initPromise;
}
```

- [ ] **Step 6: Rewrite `cancelSession`**

```ts
cancelSession(sessionId: string): boolean {
  const ps = this.sessions.get(sessionId);
  if (!ps) return false;
  // interrupt() stops current tool execution, session stays alive for new prompts
  ps.query.interrupt().catch(() => {});
  return true;
}
```

- [ ] **Step 7: Rewrite `closeSession`**

```ts
closeSession(sessionId: string): boolean {
  const ps = this.sessions.get(sessionId);
  if (!ps) return false;
  ps.inputQueue.end();
  ps.query.close();
  this.sessions.delete(sessionId);
  this.emitSessionUpdate(sessionId);
  return true;
}
```

- [ ] **Step 8: Rewrite `getCardBuilder` and `getCards` (no changes needed)**

These methods read from `ps.cardBuilder` which is still on `PersistentSession`. No changes.

- [ ] **Step 9: Remove `SessionIdRef` interface and `createDeferred` helper**

Delete these — they were only needed for the `sessionIdRef` pattern in the v2 Session API.

- [ ] **Step 10: Type-check**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 11: Commit**

```
refactor: replace v2 Session API with query() streaming input
```

---

### Task 3: Rewrite the consumer loop (`consumeStream` → `consumeQueryStream`)

**Files:**
- Modify: `apps/agent/src/ai/claudeCodeService.ts`

The old `consumeStream` created a new `for await` loop per turn and exited on `result`. The new `consumeQueryStream` runs for the session's entire lifetime, handling multiple turns.

- [ ] **Step 1: Write `consumeQueryStream`**

Replace the old `consumeStream` method with:

```ts
/**
 * Single consumer loop for a Query's entire lifetime.
 * Handles all turns — on `result`, emits card-stream-end but continues
 * consuming for the next turn. Exits only when the query closes.
 */
private consumeQueryStream(
  q: Query,
  inputQueue: AsyncQueue<SDKUserMessage>,
  initialStreamId: string,
  cwd: string,
  permissionLevel: PermissionLevel,
  onSessionId: (id: string) => void,
): void {
  let textBuffer = '';
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  let capturedSessionId: string | null = null;
  let streamId = initialStreamId;
  let cb = new StreamCardBuilder('', streamId);

  const emitCard = (event: CardEvent) => {
    this.emit('card-event', event);
  };

  const flushText = () => {
    if (textBuffer) {
      emitCard(cb.assistantText(textBuffer));
      textBuffer = '';
    }
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      bufferTimer = null;
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

  const markTurnDone = () => {
    if (capturedSessionId) {
      const ps = this.sessions.get(capturedSessionId);
      if (ps) {
        ps.streaming = false;
        ps.cardBuilder = null;
      }
      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);
      this.emitSessionUpdate(capturedSessionId);
    }
  };

  // Fire-and-forget — the loop runs until the query closes
  (async () => {
    try {
      for await (const message of q) {
        // ── Init ──
        if (message.type === 'system' && (message as any).subtype === 'init') {
          capturedSessionId = message.session_id;
          cb = new StreamCardBuilder(capturedSessionId, streamId);
          console.log(`[stream] init session=${capturedSessionId}`);
          onSessionId(capturedSessionId);

          // Register the session on first init
          if (!this.sessions.has(capturedSessionId)) {
            this.sessions.set(capturedSessionId, {
              query: q,
              inputQueue,
              sessionId: capturedSessionId,
              cwd,
              streaming: true,
              permissionLevel,
              cardBuilder: cb,
            });
          } else {
            // Subsequent turns — update cardBuilder
            const ps = this.sessions.get(capturedSessionId)!;
            ps.streaming = true;
            ps.cardBuilder = cb;
          }
          this.emitSessionUpdate(capturedSessionId);
          continue;
        }

        // ── Subagent lifecycle events (unchanged) ──
        if (message.type === 'system' && (message as any).subtype === 'task_started') {
          const m = message as any;
          flushText();
          emitCard(cb.subagentStart(m.description ?? '', m.task_id, m.tool_use_id));
          continue;
        }
        if (message.type === 'system' && (message as any).subtype === 'task_progress') {
          const m = message as any;
          const cardEvt = cb.subagentProgress(m.task_id, m.tool_use_id, m.usage?.tool_uses, m.last_tool_name);
          if (cardEvt) emitCard(cardEvt);
          continue;
        }
        if (message.type === 'system' && (message as any).subtype === 'task_notification') {
          const m = message as any;
          const cardEvt = cb.subagentEnd(m.task_id, m.tool_use_id, m.status, m.summary);
          if (cardEvt) emitCard(cardEvt);
          continue;
        }

        // ── Session state changed ──
        if (message.type === 'system' && (message as any).subtype === 'session_state_changed') {
          continue;
        }

        // ── Streaming partial events ──
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

        // ── Complete assistant messages ──
        if (message.type === 'assistant') {
          if ((message as any).agentId) continue;
          flushText();
          const betaMessage = (message as any).message;
          const blocks = betaMessage?.content ?? [];
          for (const block of blocks) {
            if (block.type === 'thinking' && block.thinking) {
              emitCard(cb.thinkingBlock(block.thinking));
            } else if (block.type === 'redacted_thinking') {
              emitCard(cb.thinkingBlock('[Redacted thinking]'));
            } else if (block.type === 'text' && block.text) {
              emitCard(cb.assistantText(block.text));
            } else if (block.type === 'tool_use' && block.name !== 'Agent') {
              emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
            } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
              emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
            }
          }
          continue;
        }

        // ── User messages contain tool results ──
        if (message.type === 'user') {
          if ((message as any).agentId) continue;
          const userMsg = (message as any).message;
          if (userMsg?.content && Array.isArray(userMsg.content)) {
            for (const block of userMsg.content) {
              if (block.type === 'tool_result') {
                const resultContent = extractToolResultText(block.content);
                const cardEvt = cb.toolResult(block.tool_use_id, resultContent, !!block.is_error);
                if (cardEvt) emitCard(cardEvt);
              }
              if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result' ||
                  block.type === 'mcp_tool_result' || block.type === 'code_execution_tool_result' ||
                  block.type === 'tool_search_tool_result') {
                const resultContent = extractToolResultText(block.content ?? block.text ?? '');
                const parentId = block.tool_use_id;
                if (parentId) {
                  const cardEvt = cb.toolResult(parentId, resultContent, !!block.is_error);
                  if (cardEvt) emitCard(cardEvt);
                }
              }
            }
          }
          continue;
        }

        // ── Turn result — DON'T exit, continue for next turn ──
        if (message.type === 'result') {
          if ((message as any).session_id !== capturedSessionId) {
            console.log(`[stream] skip subagent result session=${(message as any).session_id?.slice(0, 8)}`);
            continue;
          }
          flushText();
          const result = message as any;
          console.log(`[stream] result session=${capturedSessionId} subtype=${result.subtype} cost=$${result.total_cost_usd?.toFixed(4) ?? '?'}`);

          const streamEnd: CardStreamEnd = {
            streamId,
            sessionId: capturedSessionId ?? '',
            success: result.subtype === 'success',
            error: result.subtype !== 'success'
              ? (result.errors?.join('; ') || `Session ended: ${result.subtype}`)
              : undefined,
            totalCostUsd: result.total_cost_usd,
            tokenUsage: result.usage
              ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
              : undefined,
          };
          this.emit('card-stream-end', streamEnd);
          markTurnDone();
          // DON'T return — loop continues for next turn
          continue;
        }
      }

      // Query generator exhausted (session closed)
      flushText();
      console.log(`[stream] query closed session=${capturedSessionId}`);
      markTurnDone();
    } catch (error) {
      flushText();
      console.error(`[stream] error session=${capturedSessionId}:`, error);
      markTurnDone();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const endPayload: CardStreamEnd = {
        streamId,
        sessionId: capturedSessionId ?? '',
        success: false,
        error: msg,
      };
      this.emit('card-stream-end', endPayload);
    } finally {
      // Clean up the session from the map if the query is truly done
      if (capturedSessionId) {
        this.sessions.delete(capturedSessionId);
        this.emitSessionUpdate(capturedSessionId);
      }
    }
  })();
}
```

Key differences from old `consumeStream`:
- Runs for the session's entire lifetime, not one turn
- On `result`: emits `card-stream-end` + `markTurnDone()` but `continue`s the loop
- On next `init` (next turn): creates fresh `StreamCardBuilder`, updates session state
- When the query generator exhausts (session closed): exits loop and cleans up
- `PersistentSession` is registered from within the consumer (on first `init`), not from `startSession`/`resumeSession`

- [ ] **Step 2: Delete old `consumeStream` method**

Remove the entire old `consumeStream` method.

- [ ] **Step 3: Type-check**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```
refactor: replace per-turn consumeStream with session-lifetime consumer loop
```

---

### Task 4: Run full test suite and type-check PWA

- [ ] **Step 1: Run agent tests**

Run: `cd apps/agent && npx vitest run`
Expected: All 98+ tests pass

- [ ] **Step 2: Type-check PWA**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: 0 errors (PWA doesn't import from claudeCodeService directly)

- [ ] **Step 3: Fix any issues found**

If tests fail, fix them. The MessageHandler tests should be unaffected since they don't test streaming behavior. If type errors appear, fix mismatched types.

- [ ] **Step 4: Commit**

```
test: verify all tests pass after query() migration
```

---

### Task 5: Update architecture docs

**Files:**
- Modify: `docs/references/quicksave-architecture.en.md`

- [ ] **Step 1: Update session lifecycle section**

Update the `ClaudeCodeService` section to reflect:
- Uses `query()` with streaming input instead of `createSession`/`resumeSession`
- `AsyncQueue<SDKUserMessage>` feeds prompts to the query
- Single consumer loop per session handles all turns
- `query.interrupt()` for cancel, `query.close()` for termination
- Hot resume = push to queue, cold resume = new `query()` with `resume` option

- [ ] **Step 2: Commit**

```
docs: update architecture for query() streaming input migration
```

---

## Verification Checklist

After all tasks complete, verify these behaviors work end-to-end:

1. **New session** — PWA sends `claude:start` → agent creates query → first turn streams cards → result arrives → session stays alive
2. **Resume (hot)** — PWA sends `claude:resume` while session is idle → prompt pushed to queue → new turn streams
3. **Resume (hot, mid-stream)** — PWA sends `claude:resume` while previous turn is streaming → prompt enqueued → current turn completes → next turn starts automatically
4. **Resume (cold)** — daemon restarted → PWA sends `claude:resume` → new query with `resume` option → session works
5. **Cancel** — PWA sends `claude:cancel` → `query.interrupt()` → current tool stops → session stays alive for new prompts
6. **Close** — PWA sends `claude:close` → `query.close()` → session terminated
7. **Permission request** — `canUseTool` fires → permission card emitted → PWA approves → tool runs
