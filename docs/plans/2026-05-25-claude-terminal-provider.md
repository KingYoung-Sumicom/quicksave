# Claude Terminal Provider

**Goal:** Add a second Claude provider (`claude-terminal`) that drives `claude` in interactive TUI mode inside a PTY, intercepts turns via Stop / PreToolUse / PostToolUse hooks, and tails the session JSONL for the authoritative structured form. Coexists with the existing `ClaudeCliProvider` (stream-json) so users can pick per session.

## Background

### Policy driver

From [Anthropic's June 15 2026 SDK policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):

- **Covered by the new Agent SDK monthly credit pool** (Pro $20, Max 5x $100, Max 20x $200): `claude -p`, Agent SDK, Claude Code GitHub Actions, third-party apps authenticating via the Agent SDK.
- **Covered by the regular subscription pool**: interactive Claude Code in the terminal / IDE; Claude conversations on web, desktop, mobile.

Quicksave's current `ClaudeCliProvider` spawns `claude -p --input-format stream-json --output-format stream-json --replay-user-messages` — structurally an SDK-style consumer. Heavy Quicksave users (the maintainer included) will hit the small credit pool quickly post-6/15.

### Reframing

We position Quicksave as a **web-based enhanced terminal**. The PTY is the primary thing the user is operating; the structured card UI is the "enhancement". This mirrors how `code-server`, `ttyd`, Tailscale SSH and Anthropic's own mobile Claude Code app present themselves — not as SDK consumers.

We don't import `@anthropic-ai/claude-agent-sdk`, don't call `api.anthropic.com` ourselves, and authenticate as the user's official `claude` binary subprocess.

### Prior art validating the approach

- **smithersai/claude-p** — drop-in `claude -p` replacement that runs the interactive TUI inside a zmux PTY, injects `SessionStart` + `Stop` hooks via `--settings`, reads `transcript_path` from the Stop hook payload to extract the final message. Caveat they document: "API instability due to reliance on undocumented hook schemas."
- **slopus/happy** — closest competitor, also wraps `claude` per `happy claude` entrypoint. No public position on 6/15.
- **HN discussion (id=48126281)** — community is actively converging on TUI wrappers and VSCode-via-code-server as the standard workarounds.
- **anthropics/claude-code Issue #48840** — Anthropic is aware of the `-p` + hooks + OAuth boundary problem; `--no-hooks` flag still pending.

### Confirmed local invariants

Probe in `scripts/claude-tui-jsonl-probe.ts` against v2.1.143:

- TUI mode (`claude` with no `-p`, no `--input-format`) writes the same JSONL transcript as stream-json mode, at `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
- JSONL flush is **per-message** boundary, not per token. The 10-color counting prompt landed as one ~4.5 KB write after ~4 s of streaming.
- Implies: live token feedback must come from the PTY screen; structured card events come from JSONL (and hooks).
- Permission prompts can be intercepted via `PermissionRequest` hook — the existing `ClaudeCliProvider` already uses this mechanism for bypass-mode flag.

## Architecture

### Three-channel split

```
PWA xterm.js panel        ←──  PTY raw bytes        (sub-second, token level)
PWA structured cards      ←──  Hook events          (event-boundary, low latency)
PWA structured cards      ←──  JSONL tail           (per-message, authoritative)
                                       └─ reconcile (hook-emitted card is replaced
                                          / enriched when JSONL flushes the same id)
```

| Channel | Source | Granularity | Purpose | What it can't do |
|---|---|---|---|---|
| **PTY** | node-pty `onData` via existing `terminalManager` | byte stream | Live typing display in 80×24 xterm.js | No structure — ANSI noise |
| **Hooks** | Shell command invoked by claude, forwards to daemon Unix socket | Event-level (per tool call, per turn end) | Tool-call cards appear instantly; permission UI; turn boundary | No assistant text content |
| **JSONL tail** | `fs.watch` + size polling on session JSONL | Per-message | Final structured truth; history pagination via existing `buildCardsFromHistory` | Lags streaming text by ~message duration |

### Reuse vs new

Already exists, reuse as-is:
- `apps/agent/src/terminal/terminalManager.ts` — node-pty PTY pool, scrollback, 16ms output coalescing
- `apps/pwa/src/components/terminal/TerminalView.tsx` — xterm.js component pinned to 80×24 with auto-fit font
- `apps/agent/src/ai/cardBuilder.ts::buildCardsFromHistory` — JSONL → CardEvent reconstruction (pagination, sidechain filtering, cutoff handoff)
- `apps/agent/src/ai/cardBuilder.ts::jsonlPath` — encoded-cwd path resolver
- Bus verbs `terminal:create / input / resize / close / rename` — wire protocol for PTY frames

New (this plan):
- `apps/agent/src/ai/claudeTerminal/provider.ts` — `ClaudeTerminalProvider` implements `CodingAgentProvider`
- `apps/agent/src/ai/claudeTerminal/settingsBuilder.ts` — generate `--settings` JSON with hook commands
- `apps/agent/src/ai/claudeTerminal/hookBridge.ts` — daemon-side Unix socket server
- `apps/agent/src/ai/claudeTerminal/hookHandler.ts` — small CLI invoked by claude, forwards stdin payload to the socket, returns ack
- `apps/agent/src/ai/claudeTerminal/jsonlTail.ts` — incremental JSONL watch with byte cutoff
- `apps/agent/src/ai/claudeTerminal/cardSynth.ts` — merge hook events + JSONL into CardEvents (dedupe by `tool_use_id`)
- `apps/agent/src/ai/claudeTerminal/index.ts` — barrel
- PWA: embed existing `TerminalView` above card list in active session view, link by `terminalId`

## Milestones

### M1 — Minimum vertical slice (smoke test)

Goal: a single `claude-terminal` session that spawns the TUI, finishes one turn, and renders the final assistant message as a card in PWA.

- [ ] **Task 2 partial** — `settingsBuilder` with only `Stop` hook, `hookHandler` Unix socket client, `hookBridge` listener
- [ ] **Task 3 partial** — `jsonlTail` emitting raw parsed messages on every flush
- [ ] **Task 4** — provider calls `terminalManager.create({ shell: 'claude', args: [...] })`, captures `terminalId`, watches `projects/-<encoded>/` for a fresh JSONL
- [ ] **Task 6 partial** — `ClaudeTerminalProvider` exposing `sessionId` once JSONL discovered; `sendUserMessage` writes prompt + Enter through `terminalManager.input`
- [ ] **Task 7** — `sessionManager` registers the provider, `messageHandler` routes `claude:start` with `agent: 'claude-terminal'`
- [ ] **Task 8 partial** — PWA shows the active terminal in a fixed panel above the existing card list when session's `agentId === 'claude-terminal'`

Exit criterion: jimmy can run a one-turn haiku conversation end-to-end, see live text in xterm.js, then see a structured card after the turn completes.

### M2 — Live tool calls

- [ ] **Task 2 complete** — add `PreToolUse` / `PostToolUse` / `PermissionRequest` / `UserPromptSubmit` hooks
- [ ] **Task 5** — `cardSynth` merges hook + JSONL signals, dedupes by `tool_use_id`, reconciles hook-emitted tool_use card with JSONL final form
- [ ] **Task 6 complete** — provider wires `cardSynth` output into `callbacks.emitCardEvent`

Exit criterion: when claude calls `Bash` mid-turn, the PWA card shows up within ~100 ms (from hook), and gets enriched with `tool_result` content as it arrives.

### M3 — Polish + parity

- [ ] **Task 3 complete** — cutoff handoff so `getCards` correctly stops reading JSONL at the live-turn boundary (mirror `ClaudeCliProvider`'s `jsonlCutoff`)
- [ ] Permission UI: `PermissionRequest` hook → daemon → PWA dialog → keystroke not needed (hook returns the decision)
- [ ] Bypass-mode sentinel-file hook (re-use the existing pattern from `claudeCliProvider.ts`)
- [ ] Context window / model live switching: replicate the `update_environment_variables` and `set_model` paths if applicable in TUI mode (probably not — investigate)
- [ ] Interrupt: `Ctrl+C` keystroke into PTY via `terminalManager.input`, no `interrupt` control_request needed
- [ ] **Task 9** — tests + docs sync (architecture + agent-cli)

## Hook → Card mapping

| Hook event | Payload fields used | CardEvent emitted |
|---|---|---|
| `UserPromptSubmit` | `prompt`, `session_id`, `transcript_path` | mark turn start (set `activeTurn=true`, refresh `jsonlCutoff`) |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `cardBuilder.toolUse(...)` immediately |
| `PostToolUse` | `tool_response`, `tool_use_id`, `is_error` | `cardBuilder.toolResult(...)` immediately |
| `PermissionRequest` | `tool_name`, `tool_input`, `tool_use_id` | hand to `callbacks.handlePermissionRequest`, hook prints decision JSON back |
| `Stop` | `session_id`, `transcript_path` | flush trailing JSONL diff, emit `result` stream-end |
| `SubagentStop` | `task_id` etc. | mirror existing sidechain handling |

JSONL backfills:
- Assistant text content (hooks don't carry it) → emit `assistantText` cards from JSONL
- `ai-title` events → use as session title hint (something `ClaudeCliProvider` currently misses)
- `compact_boundary` → existing systemMessage path
- `turn_duration` → debug log only

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anthropic deprecates or changes hook schema without notice | M | H | Wrap hook payload parsing in zod; log schema-drift warnings; isolate fallout to `cardSynth` |
| Anthropic adds `--no-hooks` requiring API key (Issue #48840 outcome) | L | M | Hooks are optional refinements — JSONL tail alone still produces correct (slower) cards |
| Anthropic classifies our PTY + hooks pattern as "automation" | M | H | Reframe in PWA copy as "remote terminal" not "AI assistant"; emphasize human-driven per-turn |
| JSONL flush stalls during long tool runs | L | M | Hook events fill the gap (`PreToolUse` fires before tool flushes) |
| Race: hook fires before JSONL flush of same event | H | L | `cardSynth` dedupe by `tool_use_id` — first-wins, JSONL enriches in place |
| PTY scrollback explodes RAM under spammy output | L | M | Existing 256KiB scrollback cap in `terminalManager` already handles this |
| Multi-tab PWA double-renders terminal output | L | L | Existing `terminal:output` subscription model handles fan-out |

## Non-goals (explicitly out of scope)

- Parsing ANSI escape codes to reconstruct text content (we use JSONL for that)
- Auto-typing into the TUI to drive flows the hook system can't (smithersai/claude-p does this via SessionStart — we'll send via `terminal:input` instead, no synthetic SessionStart hook)
- Replacing `ClaudeCliProvider` — coexist; let the field tell us which wins
- Codex terminal mode — same pattern probably applies but file for separate plan once we know
- VSCode-style file editor integration — separate enhancement track
- Hooks-as-policy-enforcement (denying tools globally based on hook input) — bypass-mode hook already covers our use case

## Open questions

1. **Will Anthropic detect TUI-spawned-by-non-TTY-parent as "automated"?** No way to verify externally. We accept the risk; if they tighten, we have `ClaudeCliProvider` as fallback (which still works on the small SDK credit pool — slower but legal).
2. **Should `claude-terminal` become the default for new users?** Defer until M2 ships and we have one week of dogfooding.
3. **JSONL pagination cutoff in the presence of mid-turn pageloads** — the existing `jsonlCutoff` mechanism handles this; verify it still works when the live source is hooks + tail rather than stdout.

## File layout summary

```
apps/agent/src/ai/claudeTerminal/
├── index.ts
├── provider.ts             # ClaudeTerminalProvider
├── settingsBuilder.ts      # --settings JSON with hook commands
├── hookBridge.ts           # daemon Unix socket server
├── hookHandler.ts          # CLI script invoked by claude, forwards to socket
├── jsonlTail.ts            # fs.watch + size polling on session JSONL
├── cardSynth.ts            # merge hook + jsonl → CardEvent (dedupe by tool_use_id)
└── __tests__/
    ├── settingsBuilder.test.ts
    ├── cardSynth.test.ts
    └── jsonlTail.test.ts
```

## Docs to update on merge

Per `AGENTS_SHARED.md` sync pointers:

- `docs/references/quicksave-architecture.en.md` § 2 (SessionManager/Provider) and § 4 (message types — `terminal:*` verbs already there)
- `docs/references/agent-cli.md` if any new CLI behaviour exposed
- `docs/references/claude-code-cli-control-requests.md` — add a sibling section on hook schemas we depend on
