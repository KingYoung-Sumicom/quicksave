# Claude Agent SDK v1 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ClaudeSdkProvider` that implements `CodingAgentProvider` using the `@anthropic-ai/claude-agent-sdk` v1 `query()` API, as an alternative to the existing `ClaudeCliProvider`.

**Architecture:** The SDK provider calls `query({ prompt, options })` which returns an `AsyncGenerator<SDKMessage>`. Messages are the same types as stream-json (assistant, user, system, result, stream_event) since the CLI wrapper reads them identically. The key difference: permissions go through a `canUseTool` callback in Options (instead of stdin control_request/response), and multi-turn uses `AsyncIterable<SDKUserMessage>` as prompt (instead of stdin writes). The provider implements `CodingAgentProvider` and plugs into the existing `SessionManager` unchanged.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (npm), TypeScript, existing `CodingAgentProvider` interface

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/agent/src/ai/claudeSdkProvider.ts` | **NEW** — `ClaudeSdkProvider` implements `CodingAgentProvider` using SDK `query()` |
| `apps/agent/src/ai/asyncQueue.ts` | **NEW** — Simple `AsyncQueue<T>` (AsyncIterable) for multi-turn prompt delivery |
| `apps/agent/src/ai/provider.ts` | **MODIFY** — Add optional `providerType` field to `StartSessionOpts` (so SessionManager can pick provider) |
| `apps/agent/src/ai/sessionManager.ts` | **MODIFY** — Accept multiple providers, route based on config |
| `apps/agent/src/handlers/messageHandler.ts` | **MODIFY** — Pass `ClaudeSdkProvider` as second provider |

---

### Task 1: Create AsyncQueue utility

A simple async iterable queue — push messages in, consumer awaits them out. Used to feed multi-turn prompts to `query()`.

**Files:**
- Create: `apps/agent/src/ai/asyncQueue.ts`
- Create: `apps/agent/src/ai/asyncQueue.test.ts`

- [ ] **Step 1: Write tests for AsyncQueue**

```typescript
// apps/agent/src/ai/asyncQueue.test.ts
import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './asyncQueue.js';

describe('AsyncQueue', () => {
  it('yields pushed values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const values: number[] = [];
    for await (const v of q) values.push(v);
    expect(values).toEqual([1, 2, 3]);
  });

  it('waits for values when consumed before push', async () => {
    const q = new AsyncQueue<string>();
    const result: string[] = [];

    const consumer = (async () => {
      for await (const v of q) result.push(v);
    })();

    // Push after consumer starts waiting
    await new Promise((r) => setTimeout(r, 10));
    q.push('a');
    q.push('b');
    q.end();

    await consumer;
    expect(result).toEqual(['a', 'b']);
  });

  it('end() terminates the iterator', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored after end

    const values: number[] = [];
    for await (const v of q) values.push(v);
    expect(values).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/ai/asyncQueue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AsyncQueue**

```typescript
// apps/agent/src/ai/asyncQueue.ts

/**
 * A simple async iterable queue. Push values in, consume via for-await-of.
 * Call end() to signal no more values will be pushed.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(value: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent && npx vitest run src/ai/asyncQueue.test.ts`
Expected: 3 tests PASS

---

### Task 2: Create ClaudeSdkProvider

The main provider implementation.

**Files:**
- Create: `apps/agent/src/ai/claudeSdkProvider.ts`

- [ ] **Step 1: Create the SdkProviderSession class**

This wraps the SDK `Query` object and an `AsyncQueue` for multi-turn. It implements `ProviderSession`.

```typescript
// apps/agent/src/ai/claudeSdkProvider.ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import { SANDBOX_MCP_NAME } from './sandboxMcp.js';
import { AsyncQueue } from './asyncQueue.js';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  StartSessionOpts,
  ResumeSessionOpts,
  PermissionLevel,
} from './provider.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n');
  }
  return JSON.stringify(content);
}

class SdkProviderSession implements ProviderSession {
  private queryHandle: Query | null;
  private inputQueue: AsyncQueue<SDKUserMessage>;

  constructor(queryHandle: Query, inputQueue: AsyncQueue<SDKUserMessage>) {
    this.queryHandle = queryHandle;
    this.inputQueue = inputQueue;
  }

  get alive(): boolean {
    return this.queryHandle !== null;
  }

  sendUserMessage(prompt: string): void {
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    if (this.queryHandle) {
      await this.queryHandle.interrupt();
    }
  }

  kill(): void {
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = null;
    }
    this.inputQueue.end();
  }
}
```

- [ ] **Step 2: Add the ClaudeSdkProvider class with buildOptions helper**

```typescript
// Continue in claudeSdkProvider.ts

export class ClaudeSdkProvider implements CodingAgentProvider {

  private buildOptions(
    opts: { cwd: string; model?: string; permissionLevel: PermissionLevel; sandboxed: boolean; resumeSessionId?: string },
    callbacks: ProviderCallbacks,
  ): Options {
    const options: Options = {
      cwd: opts.cwd,
      settingSources: ['project'],
    };

    if (opts.model) options.model = opts.model;

    // Map PermissionLevel to SDK's permissionMode
    if (opts.permissionLevel === 'bypassPermissions') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
    } else if (opts.permissionLevel) {
      options.permissionMode = opts.permissionLevel as Options['permissionMode'];
    }

    if (opts.resumeSessionId) {
      options.resume = opts.resumeSessionId;
    }

    // canUseTool: bridge SDK permission callback → SessionManager's handlePermissionRequest
    options.canUseTool = async (toolName, input, permOpts) => {
      // The sessionId comes from the init message; we capture it in startSession/resumeSession
      // For now, we use a placeholder that gets filled after init
      const decision = await callbacks.handlePermissionRequest('pending', {
        toolName,
        toolInput: input,
        toolUseId: permOpts.toolUseID,
      });

      if (decision.action === 'deny') {
        return { behavior: 'deny', message: decision.response || 'Denied' } as PermissionResult;
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput } as PermissionResult;
    };

    // Inject sandbox MCP server
    const tsPath = join(__ownDir, 'sandboxMcpStdio.ts');
    const jsPath = join(__ownDir, 'sandboxMcpStdio.js');
    const hasTsPath = existsSync(tsPath);
    options.mcpServers = {
      [SANDBOX_MCP_NAME]: {
        type: 'stdio' as const,
        command: hasTsPath ? 'npx' : 'node',
        args: hasTsPath
          ? ['tsx', tsPath, '--cwd', opts.cwd]
          : [jsPath, '--cwd', opts.cwd],
      },
    };

    return options;
  }

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const options = this.buildOptions({
      cwd: opts.cwd,
      model: opts.model,
      permissionLevel: opts.permissionLevel,
      sandboxed: opts.sandboxed,
    }, callbacks);

    // Push first user message
    inputQueue.push({
      type: 'user',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    } as SDKUserMessage);

    const q = sdkQuery({ prompt: inputQueue, options });
    const session = new SdkProviderSession(q, inputQueue);

    // Wait for init to get sessionId
    const sessionId = await this.waitForInit(q, callbacks, cardBuilder, opts.streamId);

    // Start consuming stream (fire and forget)
    this.consumeStream(sessionId, opts.streamId, q, cardBuilder, callbacks);

    return { sessionId, session };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const options = this.buildOptions({
      cwd: opts.cwd,
      permissionLevel: opts.permissionLevel,
      sandboxed: opts.sandboxed,
      resumeSessionId: opts.sessionId,
    }, callbacks);

    // Push resume prompt
    inputQueue.push({
      type: 'user',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    } as SDKUserMessage);

    const q = sdkQuery({ prompt: inputQueue, options });
    const session = new SdkProviderSession(q, inputQueue);

    // Wait for init
    const sessionId = await this.waitForInit(q, callbacks, cardBuilder, opts.streamId);

    this.consumeStream(sessionId, opts.streamId, q, cardBuilder, callbacks);

    return { sessionId, session };
  }

  private async waitForInit(
    q: Query,
    callbacks: ProviderCallbacks,
    _cb: StreamCardBuilder,
    _streamId: string,
  ): Promise<string> {
    // Manually pull messages until we get the init system message
    const buffered: SDKMessage[] = [];

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init' && (msg as any).session_id) {
        if ((msg as any).model) {
          callbacks.onModelDetected((msg as any).model);
        }
        // Return sessionId; buffered messages will be replayed by consumeStream
        // Actually, since we've already consumed them from the generator,
        // we need to process them in consumeStream. We'll pass them via closure.
        return (msg as any).session_id;
      }
      buffered.push(msg);
    }
    throw new Error('Query ended without init message');
  }

  // ... consumeStream and routeMessage follow (Step 3)
}
```

**Note:** The `waitForInit` approach has a subtlety — messages consumed before init need to be replayed. This will be handled in Step 3 with a buffering approach.

- [ ] **Step 3: Add consumeStream and routeMessage methods**

The message routing is very similar to `ClaudeCliProvider.routeMessage` because the SDK emits the same message types as stream-json. The key differences:
1. No `control_request`/`control_response` — permissions go through `canUseTool` callback
2. Messages are typed `SDKMessage` instead of raw JSON
3. `stream_event` is `SDKPartialAssistantMessage` with `type: 'stream_event'`

```typescript
  // Continue in ClaudeSdkProvider class

  private async consumeStream(
    sessionId: string,
    streamId: string,
    q: Query,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<void> {
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let resultEmitted = false;

    const emitCard = (event: CardEvent) => callbacks.emitCardEvent(event);
    cb.startNewTurn(streamId);

    const flushText = () => {
      if (textBuffer) {
        emitCard(cb.assistantText(textBuffer));
        textBuffer = '';
      }
      if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    };

    const bufferText = (text: string) => {
      textBuffer += text;
      if (!bufferTimer) bufferTimer = setTimeout(flushText, 150);
      if (textBuffer.length > 2048) flushText();
    };

    try {
      for await (const msg of q) {
        this.routeMessage(sessionId, streamId, msg, cb, callbacks, emitCard, flushText, bufferText);
        if (msg.type === 'result') {
          resultEmitted = true;
          break;
        }
      }
    } catch (error) {
      flushText();
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: errMsg });
      resultEmitted = true;
    } finally {
      if (bufferTimer) clearTimeout(bufferTimer);
      if (!resultEmitted) {
        callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: 'Query ended unexpectedly' });
      }
    }
  }

  private routeMessage(
    sessionId: string,
    streamId: string,
    msg: SDKMessage,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    emitCard: (event: CardEvent) => void,
    flushText: () => void,
    bufferText: (text: string) => void,
  ): void {
    // System events
    if (msg.type === 'system') {
      const subtype = (msg as any).subtype;
      if (subtype === 'task_started') {
        flushText();
        emitCard(cb.subagentStart((msg as any).description ?? '', (msg as any).task_id, (msg as any).tool_use_id));
      } else if (subtype === 'task_progress') {
        const cardEvt = cb.subagentProgress((msg as any).task_id, (msg as any).tool_use_id, (msg as any).usage?.tool_uses, (msg as any).last_tool_name);
        if (cardEvt) emitCard(cardEvt);
      } else if (subtype === 'task_notification') {
        const cardEvt = cb.subagentEnd((msg as any).task_id, (msg as any).tool_use_id, (msg as any).status, (msg as any).summary);
        if (cardEvt) emitCard(cardEvt);
      }
      return;
    }

    // Streaming partial events
    if (msg.type === 'stream_event') {
      const event = (msg as any).event;
      if (event?.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          bufferText(delta.text);
        }
      }
      return;
    }

    if (msg.type === 'rate_limit_event') return;

    // Complete assistant messages
    if (msg.type === 'assistant') {
      if ((msg as any).agentId) return; // sidechain — SDK uses parent_tool_use_id instead
      if ((msg as any).parent_tool_use_id) return; // subagent message
      flushText();
      const blocks = (msg as any).message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          emitCard(cb.thinkingBlock(block.thinking));
        } else if (block.type === 'redacted_thinking') {
          emitCard(cb.thinkingBlock('[Redacted thinking]'));
        } else if (block.type === 'text' && block.text) {
          // Avoid text doubling: finalize if already streamed
          const finalizeEvt = cb.finalizeAssistantText();
          if (finalizeEvt) {
            emitCard(finalizeEvt);
          } else {
            emitCard(cb.assistantText(block.text));
          }
        } else if (block.type === 'tool_use') {
          if (block.name !== 'Agent') {
            emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
          }
        } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
        }
      }
      return;
    }

    // User messages (tool results)
    if (msg.type === 'user') {
      if ((msg as any).parent_tool_use_id) return; // subagent
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultContent = extractToolResultText(block.content);
            const cardEvt = cb.toolResult(block.tool_use_id, resultContent, !!block.is_error);
            if (cardEvt) emitCard(cardEvt);
          }
          if (['web_search_tool_result', 'web_fetch_tool_result', 'mcp_tool_result',
               'code_execution_tool_result', 'tool_search_tool_result'].includes(block.type)) {
            const resultContent = extractToolResultText(block.content ?? block.text ?? '');
            if (block.tool_use_id) {
              const cardEvt = cb.toolResult(block.tool_use_id, resultContent, !!block.is_error);
              if (cardEvt) emitCard(cardEvt);
            }
          }
        }
      }
      return;
    }

    // Result
    if (msg.type === 'result') {
      flushText();
      const r = msg as any;
      const interrupted = r.terminal_reason === 'aborted_tools' || r.terminal_reason === 'aborted_streaming';

      if (interrupted) emitCard(cb.systemMessage('User interrupted'));

      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);

      callbacks.emitStreamEnd({
        streamId,
        sessionId,
        success: r.subtype === 'success' && !interrupted,
        error: (r.subtype !== 'success' && !interrupted)
          ? (r.result || `Session ended: ${r.subtype}`)
          : undefined,
        interrupted,
        totalCostUsd: r.total_cost_usd,
        tokenUsage: r.usage
          ? { input: r.usage.input_tokens, output: r.usage.output_tokens }
          : undefined,
      });

      cb.clearCards();
    }
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

---

### Task 3: Fix canUseTool sessionId binding

The `canUseTool` callback in `buildOptions` uses `'pending'` as sessionId since it's not known at options-build time. We need to capture sessionId from init and update the closure.

**Files:**
- Modify: `apps/agent/src/ai/claudeSdkProvider.ts`

- [ ] **Step 1: Add sessionId capture to the canUseTool closure**

Replace the `buildOptions` method to use a mutable sessionId ref:

```typescript
  private buildOptions(
    opts: { cwd: string; model?: string; permissionLevel: PermissionLevel; sandboxed: boolean; resumeSessionId?: string },
    callbacks: ProviderCallbacks,
    sessionIdRef: { current: string },  // mutable ref, updated after init
  ): Options {
    // ... same as before, but canUseTool uses sessionIdRef.current:
    options.canUseTool = async (toolName, input, permOpts) => {
      const decision = await callbacks.handlePermissionRequest(sessionIdRef.current, {
        toolName,
        toolInput: input,
        toolUseId: permOpts.toolUseID,
      });
      if (decision.action === 'deny') {
        return { behavior: 'deny', message: decision.response || 'Denied' } as PermissionResult;
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput } as PermissionResult;
    };
    // ... rest same
  }
```

Then in `startSession` and `resumeSession`:

```typescript
  async startSession(opts, cardBuilder, callbacks) {
    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const sessionIdRef = { current: 'pending' };
    const options = this.buildOptions({ ... }, callbacks, sessionIdRef);
    // ... push first message, create query ...
    const sessionId = await this.waitForInit(q, callbacks, cardBuilder, opts.streamId);
    sessionIdRef.current = sessionId;  // <-- update the ref
    // ... consumeStream ...
  }
```

- [ ] **Step 2: Verify compilation**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

---

### Task 4: Wire up SDK provider in SessionManager

Allow `SessionManager` to hold multiple providers and route based on a config flag.

**Files:**
- Modify: `apps/agent/src/ai/sessionManager.ts`
- Modify: `apps/agent/src/handlers/messageHandler.ts`

- [ ] **Step 1: Update SessionManager constructor to accept optional SDK provider**

```typescript
// sessionManager.ts constructor change:
constructor(
  provider: CodingAgentProvider,
  private sdkProvider?: CodingAgentProvider,
) {
  super();
  this.provider = provider;
}
```

- [ ] **Step 2: Add provider selection logic in startSession**

When `opts.useAgentSdk` is true (or a config flag), use `sdkProvider` instead of the default CLI provider:

```typescript
// In startSession, after building prompt:
const activeProvider = (opts as any).useAgentSdk && this.sdkProvider
  ? this.sdkProvider
  : this.provider;

const { sessionId, session } = await activeProvider.startSession(
  { ... }, cardBuilder, callbacks
);
```

Similarly in `resumeSession`, check if the session was originally started with SDK provider (store in ManagedSession).

- [ ] **Step 3: Update messageHandler to pass SDK provider**

```typescript
// messageHandler.ts
import { ClaudeSdkProvider } from '../ai/claudeSdkProvider.js';

private claudeService: SessionManager = new SessionManager(
  new ClaudeCliProvider(),
  new ClaudeSdkProvider(),
);
```

- [ ] **Step 4: Verify compilation and tests**

Run: `cd apps/agent && npx tsc --noEmit && npx vitest run`
Expected: PASS

---

### Task 5: Install SDK dependency

**Files:**
- Modify: `apps/agent/package.json`

- [ ] **Step 1: Install @anthropic-ai/claude-agent-sdk**

Run: `cd apps/agent && npm install @anthropic-ai/claude-agent-sdk`

- [ ] **Step 2: Verify compilation**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

**Note:** This task should be done BEFORE Task 2 in actual execution so imports resolve. Listed here for logical grouping but execute first.

---

### Task 6: Update architecture documentation

**Files:**
- Modify: `docs/references/quicksave-architecture.md`

- [ ] **Step 1: Add SDK provider to the provider section**

Document:
- `ClaudeSdkProvider` as second provider option
- Difference: uses `query()` API instead of spawning CLI process
- Advantage: in-process, no stdin/stdout protocol overhead, native MCP support
- Trade-off: SDK dependency, less isolation than CLI subprocess

---

## Execution Order

Due to the SDK dependency, execute in this order:
1. Task 5 (install SDK) — required for imports
2. Task 1 (AsyncQueue) — no dependencies
3. Task 2 (ClaudeSdkProvider) — depends on 1, 5
4. Task 3 (fix sessionId binding) — depends on 2
5. Task 4 (wire up) — depends on 2, 3
6. Task 6 (docs) — last

## Known Considerations

1. **waitForInit vs generator consumption**: The SDK `query()` returns an AsyncGenerator. Once we pull messages to find init, those messages are consumed. The `consumeStream` method continues pulling from the same generator, so it picks up where `waitForInit` left off. Messages between the first yield and init (rare — usually init is first) may be lost. If this is an issue, buffer them and replay.

2. **SDK message types**: The SDK types are more specific (`SDKAssistantMessage`, `SDKResultMessage`, etc.) but the shapes match what the CLI outputs. We use `as any` casts for fields not in the type union — the runtime values are there but TypeScript is strict about discriminated unions. A future cleanup could use proper type guards.

3. **Hot resume**: The SDK supports multi-turn via `AsyncIterable<SDKUserMessage>` as prompt. Our `AsyncQueue` feeds messages to the same query. After a `result` message, pushing a new user message to the queue starts the next turn automatically — no need to create a new `query()` call.

4. **Cold resume**: Pass `resume: sessionId` in Options. The SDK loads the session transcript from `~/.claude/projects/` and continues.
