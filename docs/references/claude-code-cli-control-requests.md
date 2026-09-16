# Claude Code CLI — stdio `control_request` protocol

Reference for the stdio protocol exposed by `@anthropic-ai/claude-code` when spawned in `--output-format stream-json --input-format stream-json` mode (how `ClaudeCliProvider` drives it). Use this **before** re-grepping the CLI binary whenever you need a new capability from the CLI.

## Why this doc exists

The published SDK (`@anthropic-ai/claude-agent-sdk`) only documents a subset of what the CLI accepts over stdio — many interactive features (context usage, subscription usage, slash-command internals, plugin ops, mcp_status, etc.) are only reachable via raw `control_request` messages. We discovered this when `/context`-style data was not exposed via any SDK API, but *was* reachable by sending `{"type":"control_request","request":{"subtype":"get_context_usage"}}` on stdin.

When you need a new piece of CLI behavior:
1. Check the subtype table below.
2. If it's not there, grep the binary (see "Search recipes") and add it.
3. Never reverse-engineer from scratch again.

## Sources

- **Installed binary** (authoritative — matches what users run): as of **v2.1.241** the CLI is no longer an npm-installed, readable `cli.js` bundle. It ships as a **Bun-compiled single-file native executable** — install script is `https://claude.ai/install.sh`, not npm. Find the active one via:
  ```sh
  readlink -f "$(which claude)"
  # e.g. /home/jimmy/.local/share/claude/versions/2.1.241
  ```
  All versions live side by side in `~/.local/share/claude/versions/`; the symlink `~/.local/bin/claude` points at the active one. `claude --version` gives the human-readable version.
- **Our adapter**: `apps/agent/src/ai/claudeCliProvider.ts` — constructs `control_request` objects, tracks `activeTurn`, routes `control_response` back.
- **Our shared types**: `packages/shared/src/types.ts` (`ContextUsageBreakdown`).

When verifying, **always** re-resolve the binary path above — the CLI self-updates in place (new version dirs appear under `versions/`) and new subtypes appear without changelog notes.

### Reading the binary (post-cli.js)

The compiled executable still embeds its JS source as readable text (Bun bundles rather than fully obfuscates), so `strings` still works — it's just noisier than grepping a clean `cli.js`, and minified identifiers (`Ht`, `ve`, `ye`, `O`, `Xe`, `Bt`, `ft`) are unstable across versions; don't hardcode them in scripts, re-derive per version. Two working recipes:

```sh
B="$(readlink -f "$(which claude)")"

# Enumerate every subtype (same intent as the old cli.js recipe, just via strings)
strings -a "$B" | grep -oE 'subtype:[A-Za-z0-9_]*\("[a-z_]+"\)' | sort -u

# Find a specific subtype's schema/description/handler — widen the trailing
# context window if the match gets cut off mid-schema
strings -a "$B" | grep -oE '.{80}"<SUBTYPE>".{500}' | head -3
```

`strings` on the ~340MB binary is slow and produces large output — always pipe through `grep -oE` with a narrow pattern and `head`, never dump raw.

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

See "Reading the binary" above for the current `strings`-based recipes. The rest of this section (field-name / full-schema extraction) still assumes readable source text, which the Bun binary still provides — the schema *variable names* are just re-minified every build, so grep by nearby literal strings (the `.describe(...)` text) instead of hardcoding a variable name like `kNH`.

| Goal | Command |
|---|---|
| Enumerate every subtype | `strings -a "$B" \| grep -oE 'subtype:[A-Za-z0-9_]*\("[a-z_]+"\)' \| sort -u` |
| Find a specific subtype handler/schema | `strings -a "$B" \| grep -oE '.{60}"<SUBTYPE>".{400}' \| head -5` |
| Extract full schema object near a known description string | `strings -a "$B" \| grep -oE '<schemaVar>=\w+\(\(\)=>\w+\(\{.{0,2000}' \| head -1` |

**Discovery pattern**:
1. `strings -a "$B" | grep -oE 'subtype:.{0,80}' | sort -u` — see what exists.
2. `strings -a "$B" | grep -oE '.{40}"<SUBTYPE>".{600}' | head -3` — find the `.describe(...)` text and the handler branch (`if(...subtype==="<SUBTYPE>")...`).
3. The response schema variable is usually assigned a few dozen characters after the request schema in the same match; extract it by name once you know it, for that version only.

## Subtypes seen in v2.1.241

Categorized from `strings -a "$B" | grep -oE 'subtype:[A-Za-z0-9_]*\("[a-z_]+"\)' | sort -u`. Treat this as a snapshot — re-run against the currently-installed binary to refresh; the list has grown substantially since v2.1.111 (remote thin-client mode, task scheduling, feedback flows).

### Request/response pairs (client sends, CLI answers)

| Subtype | Purpose | Response shape highlights |
|---|---|---|
| `initialize` | Handshake after spawn | caps, model, cwd |
| `interrupt` | Cancel the active turn | `{cancelled: boolean}` |
| `get_context_usage` | Full context-window breakdown | See `ContextUsageBreakdown` below |
| `get_usage` | **Experimental.** Session cost/usage totals + claude.ai plan rate-limit utilization | See "`get_usage` — subscription usage" below |
| `get_session_cost` | ANSI-stripped session cost text (what `/cost` prints) | `{text: string}` |
| `get_plan` | Read the session's current plan-mode plan file | `{exists, content?, path?}` |
| `get_binary_version` | Responder's CLI binary version (used by `/version` in `--remote` mode) | `{version, buildTime?}` |
| `list_models` | The worker's selectable model catalog. Built for remote thin-client sessions (where the worker's provider/settings/policy decide available models) but answered locally too | `{models: ModelInfo[]}` — see below |
| `get_settings` | Read merged settings | settings JSON |
| `set_permission_mode` | Change permissions mid-session | ack |
| `set_model` | Change the model mid-session | ack |
| `set_cwd` | Change working directory mid-session | ack |
| `set_color` | Change the CLI's accent color mid-session | ack |
| `set_max_thinking_tokens` | Raise/lower thinking budget | ack |
| `set_mcp_permission_mode_override` | Override permission mode for one MCP server | ack |
| `mcp_status` | Current MCP server state | per-server status array |
| `mcp_set_servers` | Replace managed MCP servers | `{added, removed, errors}` |
| `mcp_toggle` | Enable/disable a server | ack |
| `mcp_reconnect` | Reconnect a server | ack |
| `mcp_message` | Forward a JSON-RPC message to a server | varies |
| `mcp_call` | Direct tool call against an MCP server | varies |
| `cancel_async_message` | Drop a queued prompt by uuid | `{cancelled: boolean}` |
| `rewind_files` | Undo file changes since a user-message id | `{canRewind, filesChanged, insertions, deletions}` |
| `get_workspace_diff` | Diff of workspace changes | diff payload |
| `seed_read_state` | Pre-populate readFileState cache | ack |
| `read_file` | Read a file through the CLI's file-state cache | `{content?, ...}` |
| `rename_session` | Change session display name | ack |
| `register_repo_root` | Register a repo root for the session | ack |
| `register_device_hooks` | Register device-level hooks | ack |
| `apply_flag_settings` | Apply feature-flag overrides | ack |
| `plugin_install` | Install a plugin | result |
| `reload_plugins` | Reload plugins from disk | `{commands, agents, plugins}` |
| `reload_skills` | Reload skills from disk | ack |
| `post_turn_summary` | Request post-turn summary | summary |
| `memory_recall` | Ask the CLI for memory matches | matches |
| `request_user_dialog` | Trigger an in-CLI dialog | user response |
| `stop_task` | Stop a long-running task | ack |
| `submit_feedback` | Submit user feedback | ack |

### Events (CLI → client; responses are acks)

| Subtype | Meaning |
|---|---|
| `init` | Session-ready event |
| `status` | Periodic status update |
| `informational` | Generic informational event |
| `notification` | User-facing notification |
| `task_started` / `task_progress` / `task_updated` / `task_notification` / `task_summary` | Long-task lifecycle |
| `scheduled_task_fire` | A scheduled task fired |
| `hook_started` / `hook_progress` / `hook_response` / `hook_callback` / `stop_hook_summary` | Hook lifecycle & I/O |
| `local_command_output` | Output from a bash/local command |
| `compact_boundary` | Auto-compact just happened |
| `files_persisted` | File writes were flushed |
| `file_snapshot` | File snapshot taken |
| `file_suggestions` | File suggestion event |
| `elicitation` / `elicitation_complete` | User-input gating (MCP) |
| `session_state_changed` | Permission mode / model / etc. changed |
| `vcs_state_changed` | Git/VCS state changed |
| `code_change_published` | Code change published (e.g. remote/background mode) |
| `commands_changed` | Available slash commands changed |
| `background_tasks` / `background_tasks_changed` | Background-agent task list / change |
| `agents_killed` | Background agents were killed |
| `away_summary` | Summary generated while user was away |
| `oauth_token_refresh` / `host_auth_token_refresh` | Token was refreshed |
| `api_retry` | API call is being retried |
| `api_error` | API error surfaced |
| `permission_denied` / `permission_retry` | Permission-check outcomes |
| `model_fallback` / `model_consent_fallback` / `model_refusal_fallback` / `model_refusal_no_fallback` | Model-fallback lifecycle events |
| `message_rated` | User rated a message |
| `memory_saved` | Memory was saved |
| `feedback_draft_queued` | Feedback draft queued |
| `control_request_progress` | Progress update for a long-running control request |
| `thinking` / `thinking_tokens` | Thinking-stream events |
| `turn_duration` | Turn timing event |
| `worker_shutting_down` | Remote worker is shutting down |
| `mirror_error` / `error` | Error surfacing |

### Meta

| Subtype | Meaning |
|---|---|
| `success` | Generic OK envelope for responses |
| `error` | Generic error envelope for responses |

## `get_usage` — subscription usage

**This is the mechanism behind the CLI's `/usage` and `/status` screens** — the Console/API "Usage & Cost Admin API" (`/v1/organizations/usage_report/messages`, org-scoped, requires an Admin API key) is a *different, unrelated* thing and cannot see personal claude.ai subscription rate limits. `get_usage` is the only way to read a Pro/Max/Team/Enterprise user's 5-hour and weekly rate-limit windows programmatically, and it works over the already-authenticated CLI session (no separate credential needed).

Official description string (v2.1.241): "Requests the structured /usage data: session cost/usage totals plus claude.ai plan rate-limit utilization when available. **Experimental — the response shape may change.**" The SDK's own internal method name is literally `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` — treat every field as optional/nullable and fail soft.

Response shape (schema var `Nqb` in v2.1.241; zod source, not hand-verified at runtime yet):

```ts
{
  session: {
    total_cost_usd: number,
    total_api_duration_ms: number,
    total_duration_ms: number,
    total_lines_added: number,
    total_lines_removed: number,
    model_usage: Record<string, /* per-model cost/usage */ unknown>,
  },
  // null for API-key / third-party-provider (Bedrock, Vertex) sessions
  subscription_type: 'pro' | 'max' | 'team' | 'enterprise' | null,
  // false when plan rate limits don't apply (API key, Bedrock, Vertex, or
  // missing profile scope) — rate_limits will be null in that case
  rate_limits_available: boolean,
  rate_limits: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null,
    seven_day?: { utilization: number | null; resets_at: string | null } | null,
    seven_day_oauth_apps?: { utilization: number | null; resets_at: string | null } | null,
    seven_day_opus?: { utilization: number | null; resets_at: string | null } | null,
    seven_day_sonnet?: { utilization: number | null; resets_at: string | null } | null,
    // per-model weekly windows from the server's limits[] array
    model_scoped?: Array<{
      display_name: string; // e.g. "Fable"
      utilization: number | null;
      resets_at: string | null;
    }>,
  },
}
```

`utilization` is 0-100 (percentage of the window used). `resets_at` is an ISO 8601 timestamp or null.

Call it exactly like `get_context_usage` (wall-clock cap, optional method on `ProviderSession`):

```ts
async getUsage(): Promise<ClaudeUsageSnapshot | null> {
  if (!this.process || this.process.killed) return null;
  try {
    const response = await this.sendControlRequest('get_usage', undefined, 10_000, 10_000);
    return (response as ClaudeUsageSnapshot | null) ?? null;
  } catch {
    return null;
  }
}
```

## `list_models` — model catalog

Description string: "Requests the worker's selectable model catalog. Fulfills the caps.modelCatalog capability: in a remote thin-client session the worker's provider, settings cascade, and enforcement policy decide which models the session can run, so the thin client must ask rather than read its own getModelOptions()." Built for `--remote` mode, but the local handler answers it too (`{models: Ygt(y1t())}` in the v2.1.241 source), so a locally-spawned CLI can be asked for its live catalog instead of us hand-maintaining `CLAUDE_MODELS` in `packages/shared/src/types.ts` / `apps/pwa/src/lib/claudePresets.ts`.

`ModelInfo` shape (schema var `gQo`):

```ts
{
  value: string,               // model id to use in API calls
  resolvedModel?: string,      // canonical wire id an alias resolves to (e.g. 'sonnet' -> 'claude-sonnet-5')
  displayName: string,
  description: string,
  supportsEffort?: boolean,
  supportedEffortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>,
  supportsAdaptiveThinking?: boolean,
  supportsFastMode?: boolean,
  supportsAutoMode?: boolean,
  disabled?: boolean,          // visible but not selectable (e.g. excluded by org's Zero Data Retention setting); reason folded into `description`
}
```

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

`apps/agent/src/ai/claudeCliProvider.ts` exposes `sendControlRequest(subtype, body?, idleTimeoutMs?, wallClockTimeoutMs?)`:
- The idle-timeout timer **pauses during `activeTurn`**, so a request the CLI defers until the turn ends never expires on the idle clock alone. **Any caller that can fire mid-turn MUST pass `wallClockTimeoutMs`** — it caps real elapsed time regardless of `activeTurn`. Omitting it means an unanswered mid-turn request hangs forever (this caused a session-freeze bug: a `set_model` + `set_permission_mode` change made while a tool call awaited approval deadlocked the daemon).
- `setSessionConfig`'s model switch (`set_model`, 5s/5s) sends mid-turn with the wall cap and cold-respawns on failure.
- `setPermissionLevel` does NOT send mid-turn: when `activeTurn` holds it calls `CliProviderSession.queuePermissionMode(cliMode)` and the read loop flushes it via `flushPendingPermissionMode()` at the next turn end (so the switch is honored a little later instead of risking a hang or being rolled back). It only sends `set_permission_mode` inline when the session is idle.
- The read loop must NOT `await` permission decisions (`can_use_tool` → `handleControlRequest`) inline — it fires them fire-and-forget so the loop stays free to route `control_response`s for concurrent control requests. Awaiting there reintroduces the same deadlock.
- Keep method implementations optional on `ProviderSession` (`getContextUsage?()`) so non-CLI providers (Claude Agent SDK, OpenAI Codex, etc.) can simply omit them.

Example — `getContextUsage` (wall cap built in, no `Promise.race` needed):

```ts
async getContextUsage(): Promise<ContextUsageBreakdown | null> {
  if (!this.process || this.process.killed) return null;
  try {
    // idle 10s + wall-clock 10s — the wall cap is the real ceiling mid-turn.
    const response = await this.sendControlRequest('get_context_usage', undefined, 10_000, 10_000);
    return (response as ContextUsageBreakdown | null) ?? null;
  } catch {
    return null;
  }
}
```

## Keeping this doc honest

Every time you use this doc:
1. Re-resolve the binary (`readlink -f "$(which claude)"`) and verify its version still matches the top of this doc.
2. Re-run `strings -a "$B" | grep -oE 'subtype:[A-Za-z0-9_]*\("[a-z_]+"\)' | sort -u` and diff against the subtype tables. Add new ones.
3. If a schema changed (fields added/removed), extract the new one and update both this doc and the relevant shared type (`ContextUsageBreakdown`, or wherever a `get_usage`/`list_models` mirror ends up living).
