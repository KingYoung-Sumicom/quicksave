# Claude Code CLI — stdio `control_request` protocol

Reference for the stdio protocol exposed by `@anthropic-ai/claude-code` when spawned in `--output-format stream-json --input-format stream-json` mode (how `ClaudeCliProvider` drives it). Use this **before** re-grepping the CLI bundle whenever you need a new capability from the CLI.

## Why this doc exists

The Claude Code CLI is shipped as a single minified bundle. The published SDK (`@anthropic-ai/claude-agent-sdk`) only documents a subset of what the CLI accepts over stdio — many interactive features (context usage, slash-command internals, plugin ops, mcp_status, etc.) are only reachable via raw `control_request` messages. We discovered this when `/context`-style data was not exposed via any SDK API, but *was* reachable by sending `{"type":"control_request","request":{"subtype":"get_context_usage"}}` on stdin.

When you need a new piece of CLI behavior:
1. Check the subtype table below.
2. If it's not there, grep the bundle (see "Search recipes") and add it.
3. Never reverse-engineer from scratch again.

## Sources

- **Installed bundle** (authoritative — matches what users run):
  `/home/jimmy/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/cli.js`
  Currently **v2.1.111** (see `package.json` alongside the bundle).
- **Our adapter**: `apps/agent/src/ai/claudeCliProvider.ts` — constructs `control_request` objects, tracks `activeTurn`, routes `control_response` back.
- **Our shared types**: `packages/shared/src/types.ts` (`ContextUsageBreakdown`).
- **SDK type hints** (incomplete but helpful): `/home/jimmy/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`.

When verifying, **always** re-check the bundle at the path above — the CLI version advances frequently and new subtypes appear without changelog notes.

## Spawning the CLI for multi-turn stdio

**The invocation matters.** `-p` / `--print` is documented as "Print response and exit" — without the right flags the CLI terminates after the first `result` message even if stdin stays open. Our adapter in `claudeCliProvider.ts` uses:

```
--output-format stream-json
--input-format stream-json
--verbose
--permission-prompt-tool stdio
-p ''
--replay-user-messages   ← required to keep CLI alive across multiple stdin user messages
```

Bundle validation (v2.1.111): `--replay-user-messages requires both --input-format=stream-json and --output-format=stream-json`. Without it, hot-resume is impossible — you'd be forced to cold-respawn with `--resume <sessionId>` on every turn.

### Side effects of `--replay-user-messages`

Enabling this flag changes what the CLI emits on stdout:

1. **User message echoes** — every `{type:"user", message:{role:"user", content:"..."}}` we write to stdin gets emitted back on stdout with `isReplay: true`. Filter these in your `type === 'user'` branch (see `claudeCliProvider.ts` — `if (msg.isReplay) return false;`) or you'll double-render the user card.

2. **`control_response` echoes** — `control_response`s WE send to the CLI (e.g. permission decisions for `can_use_tool`) get echoed back on stdout too. There's no `isReplay` flag on these — distinguish them by checking whether `request_id` matches a locally-tracked pending request. Unmatched ones are echoes; log at debug level, not warn.

3. **`keep_alive` message type** — the CLI accepts `{type:"keep_alive"}` on stdin and silently consumes it. Useful if you need to detect CLI liveness without triggering a turn.

4. **`inputClosed` semantics** — the streaming input processor (`BY8` in v2.1.111) marks `inputClosed=true` only when stdin EOFs. Rejected pending tool-permission requests get `"Tool permission stream closed before response received"` at that point.

5. **`update_environment_variables` message type** — `{type:"update_environment_variables", variables: Record<string,string>}` patches the CLI's `process.env` live. The handler in v2.1.119 is literally `for(let[K,_] of Object.entries($.variables)) process.env[K]=_;`. Useful for env vars the CLI reads *each turn* rather than caching at startup. Verified for `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — the auto-compact threshold function reads `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` on every call, so flipping the context window mid-session takes effect on the next turn without respawning. **Not** a `control_request` — it's a top-level stdin message like `user` or `keep_alive`, and there's no ack response.

## The wire format

Every frame on the CLI's stdio is a single JSON line. The client→CLI control frame looks like:

```json
{"type":"control_request","request_id":"r_123","request":{"subtype":"<SUBTYPE>", ...}}
```

The CLI responds with:

```json
{"type":"control_response","response":{"request_id":"r_123","subtype":"success","response":{...}}}
```

or on failure:

```json
{"type":"control_response","response":{"request_id":"r_123","subtype":"error","error":"..."}}
```

Schemas are Zod objects defined with helpers named `y.object(...)`, `y.literal(...)`, etc. (Zod is bundled and aliased to `y`.) Each subtype has a `.describe(...)` call — the describe strings are the best inline documentation.

## Search recipes (use these first)

All paths below are relative to the bundle file `cli.js`:

| Goal | Command |
|---|---|
| Enumerate every subtype | `grep -oE 'subtype:\s*\w+\.literal\("[a-z_]+"\)' cli.js \| sort -u` |
| Find a specific subtype handler/schema | `grep -oE '.{60}<SUBTYPE>.{400}' cli.js \| head -5` |
| Find a response schema by field name | `grep -oE '\w+=C6\(\(\)=>y.object\(\{[^}]*<field>[^}]*\}\)[^)]*\)' cli.js \| head -3` |
| Extract full schema object | `grep -oE '<schemaVar>=C6\(\(\)=>y\.object\(\{.{0,5000}' cli.js \| head -1 \| head -c 4000` |

The `C6` helper wraps a lazy schema — response schemas are typically named like `kNH`, `NNH`, `ENH` (capitalized, 3 letters). Request schemas are named like `IAA`, `xAA`, `mAA` (alphabet-soup pairs).

**Discovery pattern**:
1. `grep -oE 'subtype:.{0,80}' cli.js | sort -u` — see what exists.
2. `grep -oE '.{40}<SUBTYPE>.{600}' cli.js | head -3` — find where it's sent from / handled.
3. If there's a response schema, it'll be `.*NH=C6(...)` a few characters before or after; extract with the full-schema recipe.

## Subtypes seen in v2.1.111

Categorized from `grep -oE 'subtype:\s*\w+\.literal\("[a-z_]+"\)' cli.js | sort -u`. Treat this as a snapshot — re-run the grep to refresh.

### Request/response pairs (client sends, CLI answers)

| Subtype | Purpose | Response shape highlights |
|---|---|---|
| `initialize` | Handshake after spawn | caps, model, cwd |
| `interrupt` | Cancel the active turn | `{cancelled: boolean}` |
| `get_context_usage` | Full context-window breakdown | See `ContextUsageBreakdown` below |
| `get_settings` | Read merged settings | settings JSON |
| `set_permission_mode` | Change permissions mid-session | ack |
| `set_model` | Change the model mid-session | ack |
| `set_max_thinking_tokens` | Raise/lower thinking budget | ack |
| `mcp_status` | Current MCP server state | per-server status array |
| `mcp_set_servers` | Replace managed MCP servers | `{added, removed, errors}` |
| `mcp_toggle` | Enable/disable a server | ack |
| `mcp_reconnect` | Reconnect a server | ack |
| `mcp_message` | Forward a JSON-RPC message to a server | varies |
| `cancel_async_message` | Drop a queued prompt by uuid | `{cancelled: boolean}` |
| `rewind_files` | Undo file changes since a user-message id | `{canRewind, filesChanged, insertions, deletions}` |
| `seed_read_state` | Pre-populate readFileState cache | ack |
| `rename_session` | Change session display name | ack |
| `apply_flag_settings` | Apply feature-flag overrides | ack |
| `plugin_install` | Install a plugin | result |
| `reload_plugins` | Reload plugins from disk | `{commands, agents, plugins}` |
| `post_turn_summary` | Request post-turn summary | summary |
| `memory_recall` | Ask the CLI for memory matches | matches |
| `request_user_dialog` | Trigger an in-CLI dialog | user response |
| `stop_task` | Stop a long-running task | ack |

### Events (CLI → client; responses are acks)

| Subtype | Meaning |
|---|---|
| `init` | Session-ready event |
| `status` | Periodic status update |
| `notification` | User-facing notification |
| `task_started` / `task_progress` / `task_updated` / `task_notification` | Long-task lifecycle |
| `hook_started` / `hook_progress` / `hook_response` / `hook_callback` | Hook lifecycle & I/O |
| `local_command_output` | Output from a bash/local command |
| `compact_boundary` | Auto-compact just happened |
| `files_persisted` | File writes were flushed |
| `elicitation` / `elicitation_complete` | User-input gating (MCP) |
| `session_state_changed` | Permission mode / model / etc. changed |
| `oauth_token_refresh` | Token was refreshed |
| `api_retry` | API call is being retried |
| `mirror_error` / `error` | Error surfacing |

### Meta

| Subtype | Meaning |
|---|---|
| `success` | Generic OK envelope for responses |
| `error` | Generic error envelope for responses |

## `ContextUsageBreakdown` — response for `get_context_usage`

Zod schema variable: `kNH` in v2.1.111. Extracted via:
```sh
grep -oE 'kNH=C6\(\(\)=>y\.object\(\{.{0,5000}' cli.js | head -1
```

Shape (fields marked `?` are optional in the Zod schema):

```ts
{
  categories: Array<{ name, tokens, color, isDeferred? }>,
  totalTokens: number,
  maxTokens: number,
  rawMaxTokens: number,
  percentage: number,
  gridRows: Array<Array<{ color, isFilled, categoryName, tokens, percentage, squareFullness }>>,
  model: string,
  memoryFiles: Array<{ path, type, tokens }>,
  mcpTools: Array<{ name, serverName, tokens, isLoaded? }>,
  deferredBuiltinTools?: Array<{ name, tokens, isLoaded }>,
  systemTools?: Array<{ name, tokens }>,
  systemPromptSections?: Array<{ name, tokens }>,
  agents: Array<{ agentType, source, tokens }>,
  slashCommands?: { totalCommands, includedCommands, tokens },
  skills?: {
    totalSkills, includedSkills, tokens,
    skillFrontmatter: Array<{ name, source, tokens }>
  },
  autoCompactThreshold?: number,
  isAutoCompactEnabled: boolean,
  messageBreakdown?: {
    toolCallTokens, toolResultTokens, attachmentTokens,
    assistantMessageTokens, userMessageTokens,
    redirectedContextTokens, unattributedTokens,
    toolCallsByType: Array<{ name, callTokens, resultTokens }>,
    attachmentsByType: Array<{ name, tokens }>
  },
  apiUsage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } | null
}
```

Our TS mirror lives at `packages/shared/src/types.ts` → `ContextUsageBreakdown`. If the schema above drifts, update both in the same change.

### Color tokens → Tailwind

CLI `color` values are semantic tokens, not hex. Current mapping in `apps/pwa/src/components/chat/ContextUsageBadge.tsx` (`CATEGORY_COLOR`):

| CLI token | Tailwind class |
|---|---|
| `promptBorder` | slate |
| `inactive` | zinc |
| `claude` | sky |
| `warning` | amber |
| `purple_FOR_SUBAGENTS_ONLY` | violet |

If you see a color token that has no mapping, grep the bundle: `grep -oE '<TOKEN>.{0,200}'` to see what the CLI renders it as, then add to the map.

## Calling from our code

`apps/agent/src/ai/claudeCliProvider.ts` exposes `sendControlRequest(subtype, body?, timeoutMs?)`:
- The idle-timeout timer **pauses during `activeTurn`**, so back-to-back turns can hang the request. Wrap in a wall-clock `Promise.race` with a `setTimeout` when calling mid-turn.
- Keep method implementations optional on `ProviderSession` (`getContextUsage?()`) so non-CLI providers (Claude Agent SDK, OpenAI Codex, etc.) can simply omit them.

Example — `getContextUsage`:

```ts
async getContextUsage(): Promise<ContextUsageBreakdown | null> {
  if (!this.process || this.process.killed) return null;
  const wallTimeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 10_000)
  );
  try {
    const response = await Promise.race([
      this.sendControlRequest('get_context_usage', undefined, 10_000),
      wallTimeout,
    ]);
    return (response as ContextUsageBreakdown | null) ?? null;
  } catch {
    return null;
  }
}
```

## Keeping this doc honest

Every time you use this doc:
1. Verify the CLI path/version at the top still matches the installed bundle.
2. Re-run `grep -oE 'subtype:\s*\w+\.literal\("[a-z_]+"\)' cli.js | sort -u` and diff against the subtype tables. Add new ones.
3. If a schema changed (fields added/removed), extract the new one and update both this doc and `ContextUsageBreakdown` (or the relevant type).
