# Claude Code Max subscription usage — API findings

Research notes on how to surface the 5-hour / 7-day usage limits of a Pro/Max Claude Code subscription inside a third-party app. Written to avoid re-doing this investigation next time we decide whether to expose usage in quicksave.

**Status as of 2026-04-17**: Anthropic does **not** provide an official/stable API for this. There are two viable unofficial paths, each with real tradeoffs documented below.

---

## TL;DR

| Path | What you get | What you pay |
|---|---|---|
| Undocumented `/api/oauth/usage` endpoint | Real `utilization` % for `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus` + `extra_usage` credits | OAuth token handling (read `~/.claude/.credentials.json`, refresh flow), risk endpoint changes, known 429-storm bug (#30930), must cache |
| `rate_limit_event` in CLI stream-json | 5h reset timestamp, `status` transitions (`allowed` → `allowed_warning` → `rejected`), overage state | Nothing — we already receive these events. But: **no `utilization` when status is `allowed`** and **no `seven_day` data in normal operation** (verified empirically, see §4) |

If you need a live "5h: 45% / 7d: 62%" percentage bar → **you must call `/api/oauth/usage`** (no way around it).
If "time until 5h reset" + "you're approaching your limit" warnings are enough → **stream events alone suffice**, zero extra network calls.

---

## 1. Official surfaces (for completeness)

These are what Anthropic publicly supports, none of them machine-readable for a third-party app:

- `/status` and `/usage` slash commands inside Claude Code (session-scoped only)
- `claude --account` CLI (macOS/Linux) — subscription tier + approximate usage
- `claude auth status --json` — subscription type only, no usage numbers
- `claude.ai/settings/usage` web dashboard

`~/.claude/stats-cache.json` is client-side token tracking, **not** the server-side subscription limits.

There is **no official REST endpoint or CLI command** that returns `{five_hour: 45%, seven_day: 62%, resets_at: ...}`. This is a 15+ duplicate feature request (see §7).

---

## 2. Undocumented `/api/oauth/usage` endpoint

### Request

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
Accept: application/json
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
User-Agent: <your app name>
```

### Response (schema verified from ClaudeBar's `ClaudeAPIUsageProbe.swift`)

```jsonc
{
  "five_hour":        { "utilization": 45.2, "resets_at": "2026-04-17T18:00:00Z" },
  "seven_day":        { "utilization": 62.1, "resets_at": "2026-04-22T00:00:00Z" },
  "seven_day_sonnet": { "utilization": 30.0, "resets_at": "..." },
  "seven_day_opus":   { "utilization": 80.0, "resets_at": "..." },
  "extra_usage": {
    "is_enabled": true,
    "used_credits": 1500,    // cents, divide by 100 for USD
    "monthly_limit": 5000
  }
}
```

`utilization` is a percentage (0–100). `resets_at` is ISO 8601.

### Token source

- File: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- macOS: also in Keychain
- Tokens are short-lived (~1h) and require refresh

### Token refresh

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "<from credentials.json>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code"
}
```

`client_id` is Claude Code CLI's official OAuth client. May change on CLI updates.

On `invalid_grant` → session expired, user must run `claude` to re-auth. On any 401/403 from `/api/oauth/usage`, refresh once then retry.

### Caveats

1. **Completely undocumented.** Can be changed or removed without notice. Graceful degradation required.
2. **Known bug** — [anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930): for some Max users, the endpoint returns persistent `429 retry-after: 0`. Plan for this.
3. **Don't hammer it.** Sensible polling: 60s TTL minimum, or trigger only when the previous `resets_at` is within 60s. Multi-client apps should cache at the agent/server layer and fan out, not call per-client.
4. **OAuth-only.** If the user authenticated via an API key (`ANTHROPIC_API_KEY`) instead of `claude login`, there is no OAuth token to use.

---

## 3. `rate_limit_event` from Claude Code CLI stream

The Claude Code CLI (v2.1.111) emits events of type `rate_limit_event` on its stream-json output. This is part of the wire protocol — `apps/agent/src/ai/claudeCliProvider.ts` already sees these messages, and currently drops them at line 594 (`if (msg.type === 'rate_limit_event') return false;`). Same story for `claudeSdkProvider.ts:427`.

### Schema (from CLI bundle zod definition)

```ts
{
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected",
    resetsAt?: number,                // unix seconds
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage",
    utilization?: number,             // 0–1 (only populated in some states, see §4)
    overageStatus?: "allowed" | "allowed_warning" | "rejected",
    overageResetsAt?: number,
    overageDisabledReason?: string,   // e.g. "org_level_disabled_until", "out_of_credits"
    isUsingOverage?: boolean,
    unifiedRateLimitFallbackAvailable?: boolean,
    surpassedThreshold?: number
  },
  uuid: string,
  session_id: string
}
```

Described in the CLI as: *"Rate limit event emitted when rate limit info changes."*

### Data source

The CLI extracts this info from API response headers on **every** `/v1/messages` call:

```
anthropic-ratelimit-unified-5h-utilization / -reset
anthropic-ratelimit-unified-7d-utilization / -reset
anthropic-ratelimit-unified-overage-status / -reset
anthropic-ratelimit-unified-overage-disabled-until
```

The event is emitted via `V.enqueue({type:"rate_limit_event", rate_limit_info:MnK(info), uuid, session_id})` when these headers indicate a change.

---

## 4. Empirical findings from quicksave's own captures

Scanned 114 session files under `~/.quicksave/debug/*-raw.jsonl`, which captures the raw CLI stream (`DebugLogger.logRawEvent`). Results across **210 real `rate_limit_event` messages**:

```
total = 210
rateLimitType = {"five_hour": 209, "<none>": 1}
status        = {"allowed": 210}
fields seen   = [isUsingOverage, overageDisabledReason, overageStatus,
                 rateLimitType, resetsAt, status]
utilization samples = 0         ← never present when status is "allowed"
seven_day events    = 0         ← never seen in normal operation
```

Sample of an actual event:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1776441600,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled_until",
    "isUsingOverage": false
  },
  "uuid": "4b4cd4f5-9dea-4ff9-a145-c1d571756d2d",
  "session_id": "e6a43ebf-729d-4144-a2bb-88fbc19067aa"
}
```

### What this means in practice

The CLI source code (`MnK` function) reveals `utilization` is only included when the API response headers carry it, which happens when a threshold is crossed (`status: "allowed_warning"`) or the limit is hit (`status: "rejected"`). While the account is comfortably under limits, the event is essentially just a reset-time heartbeat.

7-day data (`seven_day`, `seven_day_sonnet`, `seven_day_opus`) was never observed in our traces. The CLI's type enum supports them, but in normal operation they are not emitted.

### Availability matrix for stream-based approach

| UX element | Achievable from `rate_limit_event` alone? |
|---|---|
| 5h window reset countdown | ✅ updated on every turn |
| 7d window reset countdown | ❌ not emitted in normal state |
| Live 5h % bar | ❌ no `utilization` when healthy |
| Live 7d % bar | ❌ no 7d events at all |
| "Approaching limit" warning | ⚠️ only at the moment of threshold crossing |
| "Rate limited" banner | ✅ `status === "rejected"` |
| "Using overage" indicator | ✅ `isUsingOverage: true` |
| Overage disabled reason | ✅ `overageDisabledReason` is present |

---

## 5. Current quicksave state

- `apps/agent/src/ai/claudeCliProvider.ts:594` — drops `rate_limit_event` (`return false;`)
- `apps/agent/src/ai/claudeSdkProvider.ts:427` — same, drops it
- `apps/agent/src/ai/debugLogger.ts` — the raw CLI stream IS persisted under `~/.quicksave/debug/<session>-raw.jsonl` when `QUICKSAVE_DEBUG=1`, which is how §4's measurements were obtained
- No WebSocket message type, no shared type, no PWA display

To wire this up: new shared message type → propagate through `MessageHandler` → PWA store. Follow the maintenance rules in `docs/guidelines.md` about WebSocket message additions and `quicksave-architecture.md` updates.

---

## 6. Community implementations studied

### Better Agent Terminal (`tony1223/better-agent-terminal`)

Evolution is instructive. Originally (pre-v2.1.x) they ran 2-minute OAuth polling with Chrome/Firefox session-cookie fallback and sophisticated backoff (`60s × 2^streak`, localStorage cache, stale indicator). **Currently (v2.1.6)**: all OAuth polling removed — `src/stores/workspace-store.ts:22` literally says `// Usage polling removed — OAuth API calls to Anthropic have been removed. Stubs kept so consumers don't break.`

Their current implementation is purely stream-based:
- `electron/claude-agent-manager.ts:807-817` — listens for `message.type === 'rate_limit_event'`, forwards `rate_limit_info` via IPC
- `src/components/ClaudeAgentPanel.tsx` — statusline renders `5h:%` and `7d:%` from the collected events

Note: their release notes (line 160) explicitly acknowledge "SDK rate_limits lacks 7d data" — consistent with our own empirical findings. Their 7d display likely only fires in `allowed_warning`/`rejected` states.

### ClaudeBar (`tddworks/ClaudeBar`)

Takes the opposite approach — polls `/api/oauth/usage` directly. The Swift implementation in `Sources/Infrastructure/Claude/ClaudeAPIUsageProbe.swift` is the canonical reference for the endpoint's exact request/response shape and the OAuth refresh flow (captured in §2 above). Key design decisions:

- 5-minute TTL on the credential cache (so external `claude` re-login is picked up)
- Explicit handling of `invalid_grant` → signals session expired
- On 401/403 from usage endpoint, refresh once then retry
- `accessToken` loaded from `~/.claude/.credentials.json` **or** macOS Keychain

### Others

- `ohugonnot/claude-code-statusline` — shell script wrapping `/api/oauth/usage`
- `Maciek-roboblog/Claude-Code-Usage-Monitor` — CLI tool, combines local JSONL stats with OAuth endpoint
- `ryoppippi/ccusage` — pure local-JSONL analysis, doesn't hit the OAuth endpoint at all

---

## 7. Related upstream issues

Tracked in `anthropics/claude-code`:

- [#44328](https://github.com/anthropics/claude-code/issues/44328) — Feature request: `claude usage` command / API endpoint for Max subscription limits (closed as duplicate)
- [#32796](https://github.com/anthropics/claude-code/issues/32796) — Expose Max plan usage limits via Claude Code API/SDK (closed)
- [#30341](https://github.com/anthropics/claude-code/issues/30341) — Built-in status line with rate limit usage bars
- [#27915](https://github.com/anthropics/claude-code/issues/27915) — Expose rate-limit / plan quota usage in statusLine JSON input
- [#22407](https://github.com/anthropics/claude-code/issues/22407) — Include rate limit info in statusline data
- [#30930](https://github.com/anthropics/claude-code/issues/30930) — **Bug**: `/api/oauth/usage` returns persistent 429 for Max users

---

## 8. Decision matrix for quicksave

If we proceed, choose one of:

**Stream-only path**
- Add a shared WebSocket message type for rate-limit state
- Thread `rate_limit_event` through `MessageHandler` → PWA
- Display: 5h reset countdown + status-based banners (approaching / rate-limited / using overage)
- Zero new network calls, no credential handling
- Accept: no % bar, no 7d number

**Endpoint-polling path** (on top of stream-only)
- In `apps/agent`, read `~/.claude/.credentials.json`, implement refresh flow against `platform.claude.com/v1/oauth/token`
- Poll `/api/oauth/usage` with 60s–TTL cache, honor `resets_at` for adaptive intervals
- Handle `invalid_grant` → surface "re-login needed" in PWA
- Handle 429 → exponential backoff, keep last-known value
- Agent-layer cache shared across all connected clients (don't per-client poll)
- Gains: real % bars for 5h/7d/opus/sonnet, extra-usage credit balance

A hybrid is sensible: always run stream-based as the primary signal, fall back to last-known-endpoint-value for the % bar, and refresh on-demand only when user opens a "usage" panel.

---

## 9. Sources used during this research

- CLI bundle v2.1.111 at `/home/jimmy/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/cli.js` (search recipes apply — see `docs/references/claude-code-cli-control-requests.md` §"Search recipes")
- `tddworks/ClaudeBar` — `Sources/Infrastructure/Claude/ClaudeAPIUsageProbe.swift`
- `tony1223/better-agent-terminal` — `electron/claude-agent-manager.ts`, `src/stores/workspace-store.ts`, `release-note.md`
- Empirical: 210 `rate_limit_event` messages across 114 sessions in `~/.quicksave/debug/*-raw.jsonl`
- Upstream issues and Anthropic support articles (linked in §7)
