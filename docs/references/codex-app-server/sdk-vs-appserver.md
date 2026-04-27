# Codex SDK vs `app-server` — comparison and migration guidance

> **Source(s):** https://developers.openai.com/codex/app-server (positioning); https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (protocol details); https://www.infoq.com/news/2026/02/opanai-codex-app-server/ (third-party summary, used because https://openai.com/index/unlocking-the-codex-harness/ was unreachable from our network at fetch time — see TODO below).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

This file exists to answer one question: *should we keep the SDK or migrate to app-server?* TL;DR: OpenAI itself draws the line as **SDK = automation/CI, app-server = full-fidelity client integrations**. Quicksave is on the second side.

## OpenAI's own positioning

The clearest statement is on the public app-server overview page (https://developers.openai.com/codex/app-server):

> Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events.

And on the same page:

> If you are automating jobs or running Codex in CI, use the Codex SDK instead.

The upstream `codex-rs/app-server/README.md` opens with the same framing:

> `codex app-server` is the interface Codex uses to power rich interfaces such as the [Codex VS Code extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt).
>
> — `codex-rs/app-server/README.md` § (top)

The InfoQ writeup of the OpenAI announcement (https://www.infoq.com/news/2026/02/opanai-codex-app-server/) cross-checks this and also covers the architectural rationale. Two attributed quotes worth keeping:

> One user request can unfold into a structured sequence of actions that the client needs to represent faithfully: the user's input, the agent's incremental progress, artifacts produced along the way.

(That's the InfoQ summary describing the problem the app-server protocol solves.)

> OpenAI initially experimented with MCP but found that "maintaining MCP semantics in a way that made sense for VS Code proved difficult." The richer session semantics required—streaming diffs, approval flows, thread persistence—didn't map cleanly to MCP's tool-oriented design. OpenAI continues supporting Codex as an MCP server for simpler workflows but recommends the App Server for full-fidelity integrations.

These two statements are the load-bearing ones for our decision: a client like Quicksave that renders streaming diffs, surfaces approval prompts, and persists threads is exactly the use case OpenAI is recommending the app-server for.

> <!-- TODO: VERIFY against the original OpenAI blog post at https://openai.com/index/unlocking-the-codex-harness/ when access becomes available. The InfoQ article is a faithful third-party summary, but the verbatim quotes above are from InfoQ's restatement; we should swap them for the original OpenAI source on the next pass. The OpenAI page returned a network error (Claude Code unable to fetch from web.archive.org either) at the 2026-04-26 fetch attempt. -->

## What we GAIN by migrating

Concretely, mapped against today's `@openai/codex-sdk` Thread surface (`runStreamed`, callback events, `TurnOptions`):

### 1. Per-turn override semantics, made explicit

The SDK's `runStreamed({ model, sandboxMode, … })` per-call config is sticky for the same thread, but the boundaries are implicit. App-server documents the rule precisely (verbatim from `codex-rs/app-server/README.md` § Example: Start a turn (send user input)):

> You can optionally specify config overrides on the new turn. **If specified, these settings become the default for subsequent turns on the same thread.** `outputSchema` applies only to the current turn.

And every override field on `TurnStartParams` carries a doc-comment of the form *"Override the X for this turn and subsequent turns."* (See [`turns.md`](./turns.md) § The sticky-override rule for the full list.)

Practical wins:
- **More overrides than the SDK exposes**: `effort`, `summary`, `serviceTier`, `permissionProfile`, `approvalsReviewer`, `personality`, `collaborationMode`. The SDK currently lets us set `model` and `sandboxMode` per call.
- **One-shot `outputSchema`** without polluting the thread default. Use this for "give me one structured JSON answer" surfaces (commit-message generation, PR titles, classification).
- **Inspectable state**: we can call `thread/read` to see what the current sticky values resolved to, instead of guessing from local state.

### 2. `turn/steer` — mid-turn redirection

There is no SDK equivalent. App-server lets us append more user input to the **currently active** turn without spawning a new one:

```json
{ "method": "turn/steer", "id": 32, "params": {
    "threadId": "thr_123",
    "input": [ { "type": "text", "text": "Actually focus on failing tests first." } ],
    "expectedTurnId": "turn_456"
} }
```

`expectedTurnId` is a precondition — fail the request if the active turn drifted. (See [`turns.md`](./turns.md) § `turn/steer`.) The Quicksave UX win is "type a follow-up while the agent is still running" without disrupting in-flight tool calls.

### 3. Real `turn/interrupt`

Today we kill the SDK process to interrupt. App-server gives us a turn-scoped cancellation primitive that emits a `turn/completed` with `status: "interrupted"` and **leaves the thread loaded** (and background terminals running unless we also call the experimental `thread/backgroundTerminals/clean`). We can interrupt cleanly without resetting our connection.

### 4. Server-initiated approval requests with typed payloads

Today's SDK approval flow is a `can_use_tool`-style boolean callback wired through the CLI bundle. App-server replaces it with explicit JSON-RPC requests carrying `command`, `cwd`, `commandActions`, `additionalPermissions`, `availableDecisions`, full `fileChange` diffs, etc. (See [`approvals.md`](./approvals.md).)

New decision options that don't exist on the SDK side:
- `acceptForSession` — approve once, sticky for the session.
- `acceptWithExecpolicyAmendment` — accept this command and **persist a rule** so similar future commands won't prompt.
- `applyNetworkPolicyAmendment` — same idea for network-host approvals.

Plus the auto-review (`approvalsReviewer: "auto_review"`) surface is opt-in and unstable, but it's the path forward for low-trust automation runs.

### 5. Richer event stream

App-server emits 50+ typed notifications (see [`event-catalog.md`](./event-catalog.md)). Today's SDK callback surface is roughly a dozen event types. New surfaces we don't have access to today:

- **`thread/tokenUsage/updated`** — token usage at thread granularity, including post-resume restoration.
- **`turn/diff/updated`** — pre-aggregated unified diff across the whole turn (no more stitching).
- **`turn/plan/updated`** — the agent's evolving plan as a structured `{ step, status }` list.
- **`item/reasoning/summaryTextDelta`** + `summaryPartAdded` — streamed reasoning summaries with explicit section boundaries.
- **`thread/status/changed`** — `notLoaded` / `idle` / `systemError` / `active` transitions for the sidebar.
- **`model/rerouted`**, **`model/verification`** — backend-initiated model changes / account verification flags.
- **`account/rateLimits/updated`** — push-based rate-limit awareness.
- **`deprecationNotice`** — explicit signal when we're holding the API wrong.

### 6. Turn → Item lifecycle that matches our card model

Today our `StreamCardBuilder` reverse-engineers a per-card lifecycle from the SDK's flat event stream. The app-server protocol is already structured the way our cards are: every item follows `item/started` → deltas → `item/completed`, with `item.id` stable across the whole lifecycle. The card builder simplifies dramatically.

### 7. Schema generated per CLI version

`codex app-server generate-ts --out DIR` produces TS types for the exact CLI version the user has installed. Today we hand-maintain `openai-codex-sdk-types.md`. The app-server bindings give us a regenerable source of truth, with `--experimental` opt-in to surface gated APIs.

## What CHANGES contract-wise

This is the friction column. Expect to rewrite some assumptions:

### Events come as JSON-RPC notifications, not SDK callbacks

Today: `runStreamed(...).events` is an async iterable of typed objects with strongly-typed payloads handed to us by the SDK.

After migration: every event is a `{ method, params }` JSON line on stdout. We need:
- **A JSON-RPC client** (our own; or a small library). Track outstanding `id`s for request/response correlation.
- **A demultiplexer** that routes server→client `method` strings into either the card builder, the approval handler, the auth state, etc.
- **Server-initiated requests** must be answered (with an `id`-matched `result` or `error`). Failing to answer or timing out leaves the agent paused indefinitely.
- **Stderr is for logs**, not the event stream. Stdout is the only JSON-RPC channel.

The `ServerNotification.ts` and `ServerRequest.ts` unions in the generated bindings give us the exhaustive type discriminator for the demultiplexer.

### Lifecycle is explicit, not implicit

Today: the SDK opens a thread for us when we call `startThread()`; ends it when we call `archive`/finish.

After migration:
- **`initialize` + `initialized` once per process**, with a stable `clientInfo.name`. (See [`lifecycle.md`](./lifecycle.md) § `initialize`.)
- **Thread management is our responsibility**: pick `thread/start` vs `thread/resume` vs `thread/fork`. Use `thread/unsubscribe` when the user closes a session UI; the server idle-unloads after 30 min.
- **`turn/start` returns immediately** with the new turn object; the actual model work is signalled by `turn/started` later. Don't conflate the two.
- **`turn.items` on the response is unreliable** — the canonical record of what happened is the stream of `item/*` notifications.

### Sticky overrides change our store API

The SDK lets us pass `model` / `sandboxMode` on every `runStreamed` call. App-server makes the stickiness explicit: pass once, and that's the new thread default.

Concretely for Quicksave:
- The "model dropdown" UI no longer needs to attach the chosen model to every send. Set it once via `turn/start` (or `thread/start`), then let the thread inherit.
- For one-shot escalations (e.g. user clicks "rerun this with high effort"), pass `effort: "high"` on that one `turn/start` and explicitly pass `effort: <previous>` on the next turn to revert. (Or accept the new sticky value as the new default.)
- Read-back state via `thread/read` if the UI needs to display "this thread is currently using model X with effort Y."

### Approval UI must round-trip

Today: `can_use_tool` returns a boolean from a callback.

After migration:
- An `item/commandExecution/requestApproval` JSON-RPC **request** arrives with an `id`.
- We render UI, the user picks a decision.
- We respond with `{ "id": <same>, "result": { "decision": ... } }`.
- We **must** also handle `serverRequest/resolved` notifications to dismiss the dialog if the turn ends/interrupts before the user answered.

Decision payloads now include richer options (`acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `cancel`). Quicksave should expose at least `accept` / `acceptForSession` / `decline` / `cancel` in the dialog; the policy-amendment options are nice-to-have once the UI accommodates rule-editing.

### Authentication is owned by the server

Today our SDK is configured with `apiKey` from `OPENAI_API_KEY`. App-server has its own `account/login/start` flow with three modes (apiKey, chatgpt browser, chatgpt device-code) and persists tokens to `$CODEX_HOME` (default `~/.codex`).

We can:
- **Keep using API keys**: `account/login/start { type: "apiKey", apiKey: "sk-…" }`.
- **Adopt the ChatGPT-managed flow**: `account/login/start { type: "chatgpt" }` returns an `authUrl`; the app-server hosts the callback locally; tokens persist and auto-refresh. This is the path forward for ChatGPT-plan users.
- **Listen for `account/updated`** to track current auth state in the UI.

### Versioning needs schema regeneration on every CLI bump

Each CLI version emits its own schema. We should:
- Pin a **minimum CLI version** in our docs.
- Regenerate `DIR/*.ts` and check it into source control (or generate at install time).
- Diff `ServerNotification.ts` / `ServerRequest.ts` between bumps to catch new methods we should care about.
- Treat `experimentalApi` as off by default and gate any opt-in behind a Quicksave feature flag.

### Backpressure is a thing

The README is explicit:

> When request ingress is saturated, new requests are rejected with a JSON-RPC error code `-32001` and message `"Server overloaded; retry later."`. Clients should treat this as retryable and use exponential backoff with jitter.
>
> — `codex-rs/app-server/README.md` § Protocol

We need to handle `-32001` gracefully — don't tear down the connection; back off and retry the request.

## Net assessment

| Capability | SDK (`@openai/codex-sdk`) | `codex app-server` |
|------------|---------------------------|--------------------|
| Per-turn `model` / `sandbox` override | Yes (sticky, undocumented boundary) | Yes, **fully documented sticky semantics**, more fields |
| Per-turn `effort` / `summary` / `personality` / `permissionProfile` / `approvalsReviewer` | No | **Yes** |
| One-shot `outputSchema` | No (whole-thread only) | **Yes** (turn-scoped) |
| Mid-turn steer | No | **Yes** (`turn/steer`) |
| Clean turn cancel | No (kill process) | **Yes** (`turn/interrupt` → `turn/completed: interrupted`) |
| Typed approval payloads with diff/command preview | Partial (CLI-mediated) | **Yes** |
| `acceptForSession` / policy amendments | No | **Yes** |
| Token usage at thread granularity | Per-turn callback only | **Yes** (`thread/tokenUsage/updated`) |
| Aggregated turn diff | Stitch ourselves | **`turn/diff/updated`** |
| Reasoning summaries with section boundaries | No | **Yes** |
| Thread status / lifecycle notifications | Limited | **Full** (`thread/status/changed` + lifecycle notifs) |
| Auto-review subagent | No | **Yes** (experimental, unstable) |
| Realtime audio | No | **Yes** (experimental, not in scope) |
| Schema source of truth | Manual | **Generated per-CLI-version** |
| Auth flow we control | Single API key only | **API key + ChatGPT browser + device code** |
| Forward compatibility risk | Lower (SDK abstracts) | Higher (we own the wire) |

The migration is a multi-week effort but every existing pain point in our SDK integration has a documented remedy on the app-server side. The biggest cost is the JSON-RPC plumbing and the demux for the 50+ notification methods — both of which the generated TS bindings make tractable.

## Open verification gaps

Before relying on this doc in production:

1. **<!-- VERIFY -->** Whether the `ChangeLog` actually marks any specific CLI version as "stable" for the app-server surface. The changelog (https://developers.openai.com/codex/changelog) shows continuous evolution through 0.122 → 0.125 with no explicit "stabilized" milestone.
2. **<!-- VERIFY -->** Re-run our `codex app-server generate-ts --out DIR` whenever the user upgrades CLI; diff against the `0.125.0` baseline to catch new methods.
3. **<!-- VERIFY -->** The original OpenAI "Unlocking the Codex Harness" blog post at https://openai.com/index/unlocking-the-codex-harness/ was unreachable at fetch time. The verbatim quotes here are from the InfoQ summary; replace with the OpenAI source on the next pass.
