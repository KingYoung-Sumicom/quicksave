# Test Specification: OpenCodeProvider

## What to test
`apps/agent/src/ai/openCodeProvider.ts` — OpenCodeProvider class + StreamCommit parser.

## Public API surface

### `getOpenCodeBin(): string`
- Returns resolved opencode binary path.
- Uses path resolution cache (`_opencodeBin` global).
- Tries `which opencode`, common install paths, nvm.

### `OpencodeSession` class:
- `sendUserMessage(prompt, attachments?)` → no-op (single-shot CLI)
- `interrupt()` → sends `\x03` to stdin or kills
- `kill()` → SIGTERM, sets `process = null`
- `alive` → getter on `process?.killed`
- `getContextUsage()` → returns `null`

### `OpenCodeProvider` class:
- `id = 'opencode'`, `historyMode = 'memory'`, `label = 'OpenCode'`
- `setOptions(opts)` → sets `dangerouslySkipPermissions`
- `probeProvider()` → returns ProbeResult with `supportsResume: false`, `supportsStreaming: true`
- `startSession(opts, cardBuilder, callbacks)` → spawns `opencode run --format json [flags] prompt`
- `resumeSession(...)` → throws error

### CLI args built by `buildCliArgs`:
- Must include `run --format json`
- `--model <model>` if `opts.model` truthy
- `--dir <cwd>` if truthy
- `--dangerously-skip-permissions` if truthy
- Prompt as last positional arg

### `parseCommit(line)`:
- Returns parsed StreamCommit or null on JSON parse error
- Does NOT log on error (silently skip)

### Stream parser behavior (via `buildEventsFromCommit`):
- `kind: 'session', phase: 'final'` → emits `end` event (CardEvent)
- `kind: 'step', phase: 'start'` → emits `subagentStart`
- `kind: 'step', phase: 'final'` → emits `subagentEnd`
- `kind: 'text', phase: 'progress'` → buffers text, flushes at 256 chars or on final
- `kind: 'reasoning', phase: 'progress'` → accumulates, emits `thinkingBlock` on final
- `kind: 'tool', phase: 'start'` → emits `toolUse` + calls `callbacks.onToolUse`
- `kind: 'tool', phase: 'final'` → emits `toolResult`
- Tracks active text buffer across calls
- Tracks tool names map

### `consumeStream` flow:
1. Starts new turn via `cardBuilder.startNewTurn()`
2. Reads JSONL lines, parses, calls `buildEventsFromCommit`
3. Picks up real session ID from server events
4. Flows all events through `callbacks.emitCardEvent`
5. Calls `scheduleDeferredClear` after `end` event
6. On process exit without `end`: flushes remaining text, emits `emitStreamEnd` with success=false
7. Calls `onSessionExited` at end

## Files to reference for style
- `apps/agent/src/ai/openCodeProvider.ts` — what to test
- `apps/agent/src/ai/sessionManager.test.ts` — style conventions for provider tests
- `apps/agent/src/ai/provider.ts` — type definitions for ProbeResult, CardEvent, CardStreamEnd, ProviderCallbacks, StreamCardBuilder

## Test cases to write

### Module: getOpenCodeBin
1. Returns cached value on second call
2. Finds opencode in PATH via `which`
3. Falls back to nvm path when not in PATH
4. Returns bare 'opencode' string as last resort

### Module: OpencodeSession
5. `sendUserMessage` is no-op
6. `interrupt` sends SIGINT character to stdin
7. `interrupt` falls back to kill on write error
8. `kill` terminates process and clears reference
9. `alive` is true when process alive, false after kill
10. `getContextUsage` returns null

### Module: buildCliArgs
11. Always includes `run --format json`
12. Includes `--model` when model provided
13. Includes `--dir` when cwd provided
14. Includes `--dangerously-skip-permissions` when flag is true
15. Prompt is last positional arg
16. Does NOT include `--model` when model is undefined/falsy

### Module: probeProvider
17. Returns `supportsResume: false`
18. Returns `supportsStreaming: true`
19. Returns `hasCli` based on `isCliAvailable`
20. Checks both OPENCODE_API_KEY and OPENAI_API_KEY for hasApiKey

### Module: resumeSession
21. Throws Error with descriptive message

### Module: StreamCommit parser
22. `parseCommit` returns StreamCommit for valid JSON
23. `parseCommit` returns null for invalid JSON
24. `parseCommit` handles empty string

### Module: Session boundary
25. `session/final` emits CardStreamEnd with success=true
26. `session/final error` emits CardStreamEnd with success=false and error message
27. Flushes text buffer before emitting session end

### Module: Step events
28. `step/start` calls `subagentStart` with stepId and snapshot
29. `step/final completed` calls `subagentEnd` with status='completed'
30. `step/final error` calls `subagentEnd` with status='failed'

### Module: Text streaming
31. `text/progress` buffers text
32. Text flushed when buffer reaches 256 chars
33. `text/final` flushes remaining buffer
34. Empty text progress does not emit events

### Module: Reasoning
35. `reasoning/progress` accumulates text
36. `reasoning/final` emits `thinkingBlock` with accumulated text
37. Empty reasoning does not emit events

### Module: Tool calls
38. `tool/start` emits `toolUse` and calls `onToolUse` callback
39. `tool/final` emits `toolResult` with output
40. `tool/final error` emits `toolResult` with isError=true
41. Tool end removes from active toolMap
42. Duplicate tool end after already-removed tool handled gracefully

### Module: consumeStream overall
43. Calls `startNewTurn()` at beginning
44. Updates session ID from first server event
45. Calls `scheduleDeferredClear` after end event
46. Calls `emitStreamEnd` with failure when process exits without session/final
47. Flushes leftover text on unexpected exit
48. Calls `onSessionExited` at end

### Module: spawnAndConsume
49. Spawns process with correct cwd
49b. Forwards OPENCODE_API_KEY and OPENAI_API_KEY in env when set
50. Records user message event in cardBuilder and callbacks
51. Returns session with generated session ID

## Mocking constraints
- Do NOT mock `StreamCardBuilder` — use a real one (it's pure in-memory data structure).
- Do mock `ChildProcess` via `jest.mock('child_process')` — control what gets written to stdout/stderr.
- Mock the `process.stdout` readline interface to feed controlled JSONL lines to the parser.
- Mock `execSync` for `getOpenCodeBin` and `isCliAvailable` tests.
- Provide a mock `ProviderCallbacks` object to track callback invocations (emitCardEvent, emitStreamEnd, onToolUse, onSessionExited).

## Framework
Use vitest. File: `apps/agent/src/ai/openCodeProvider.test.ts`.
