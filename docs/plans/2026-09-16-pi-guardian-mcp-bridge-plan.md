# Pi Agent: Guardian Auto-Review + MCP Bridge — Prep Plan

**Date:** 2026-09-16
**Status:** Proposed (prep for a Pi migration that has not started yet)

## Summary

Quicksave is evaluating a move from OpenCode to Pi (`@earendil-works/pi-coding-agent`)
for local-model compatibility reasons unrelated to this plan. While
investigating, we found that OpenCode's `auto-review` permission mode (the
guardian LLM-reviewer feature) has a structural gap: it forces a fixed list of
permission *categories* to `ask`, and that list can silently miss a category
(it already missed `write`/`patch` — fixed in `6b240ef`) or an entire class of
actions (MCP tool calls, which OpenCode has no shared `mcp` category for at
all — each MCP tool is its own permission key).

This plan is **not** a decision to migrate. It is prep work so that *if* the
migration happens, the guardian + MCP gap is solved by construction on Pi
instead of re-implemented as a copy of OpenCode's category-list design.

Two independent pieces, tracked as one plan because they compose to answer
the same requirement ("MCP tool calls must also go through auto-review"):

1. **MCP bridge extension** — connects to configured MCP servers and
   registers their tools as ordinary Pi tools.
2. **Guardian extension** — intercepts every tool call (built-in or
   MCP-bridged, indistinguishable to Pi) and routes state-changing ones
   through an LLM reviewer, fail-closed.

They are separate Pi extensions, not one module. See "Why two extensions,
not one" below.

## External References

Official / upstream:

- Pi README + CHANGELOG, pulled via `npm pack @earendil-works/pi-coding-agent@0.85.1`
  (2026-09-05, latest at time of writing) — confirms "No MCP" and
  "No permission popups" are deliberate design stances (extensions are
  expected to add both), not gaps pending a native fix.
- `examples/extensions/permission-gate.ts` (bundled in the npm package) —
  canonical single-`tool_call`-hook interception pattern.
- `dist/core/extensions/types.d.ts` (bundled) — `ToolDefinition.parameters`
  is a TypeBox `TSchema`, confirming the JSON-Schema-in conversion work.

Third-party prior art (inspected via `npm pack`, not installed as deps):

- `pi-mcp-extension` (irahardianto) v1.5.0 — cleanest reference for the MCP
  bridge. `src/tool-bridge.ts` (494 lines): recursive JSON-Schema→TypeBox
  converter (`$ref`/`$defs`, `oneOf`/`anyOf`/`allOf`, enums, nullable,
  `Type.Any()` fallback), activate/deactivate lifecycle to avoid tool churn
  on reconnect, tool-name collision detection. `src/index.ts`: `mcpServers`
  config at `~/.pi/agent/mcp.json` (global) + `.pi/mcp.json` (project
  override) — same shape as Claude Code's `.mcp.json`.
- `pi-mcp-adapter` (nicobailon) v2.34.0, `@spences10/pi-mcp` v0.0.60 —
  alternative implementations, not read in depth. Worth a skim before
  Phase 1 in case they solve the reviewer-process problem (see Open
  Questions) more cheaply.
- `@gotgenes/pi-permission-system` v32.0.4 (fork of MasuRii/pi-permission-system)
  — permission gate extension with `mcp` as a first-class surface
  (`"*"`/`server:*`/exact-tool granularity, last-match-wins, fails closed).
  Its own `docs/opencode-compatibility.md` independently confirms: OpenCode
  has **no documented `mcp` permission surface**, and OpenCode's `edit`
  surface silently covers `write`/`apply_patch` (matches what we found and
  fixed in `6b240ef`). This is external validation, not just our own reading
  of OpenCode's source.

Local repo references to keep aligned:

- `apps/agent/src/ai/guardian.ts` — the OpenCode guardian to port from
  (hidden-reviewer pattern, `GUARDIAN_POLICY`, `GUARDIAN_ASSESSMENT_SCHEMA`,
  fail-closed timeout, circuit breaker).
- `apps/agent/src/ai/openCodeProvider.ts:1327` (`handleAutoReviewPermission`)
  — the call-site wiring pattern (per-request review, allow/deny reply,
  circuit-breaker escalation to the user).
- `apps/agent/src/ai/openCodeServer.ts:171` (`AUTO_REVIEW_PERMISSION_CATEGORIES`)
  — the category-list design we are trying to avoid repeating.
- `apps/agent/src/ai/codexMcpProvider.ts` — existing in-repo usage of
  `Client` + `StdioClientTransport` from `@modelcontextprotocol/sdk`
  (already a dependency, `apps/agent/package.json` `^1.29.0`). Proof the
  MCP client plumbing is not new to this codebase.
- `docs/pi-agent-plugin-injection.md` — how Quicksave injects extensions
  into Pi (`--extensions` flag, `ExtensionAPI` surface, RPC-mode caveats).
  Already sketches an `auto`/`ask`/`yolo` permission plugin; this plan adds
  a fourth mode (`auto-review`) and the MCP bridge alongside it.
- `docs/pi-event-types.md` §3–4 — RPC protocol and `extension_ui_request`
  framing. `piProvider.ts` currently does **not** handle
  `extension_ui_request` at all (confirmed by grep — zero permission-level
  logic exists in `piProvider.ts` today). This is greenfield, not a
  refactor.

## Why Two Extensions, Not One

- **Orthogonal concerns.** The MCP bridge answers "what tools exist and how
  do I call them." The guardian answers "should this call happen." Pi's
  `tool_call` hook fires for *any* registered tool regardless of origin, so
  the guardian needs zero MCP-specific code — it only ever sees
  `event.toolName` / `event.input`.
- **No load-order dependency.** MCP tools are registered at `session_start`;
  the guardian's hook fires at call-time, which is always after
  `session_start` has run. Either extension can be listed first in
  `--extensions`.
- **Upstream precedent.** `pi-mcp-extension` and `@gotgenes/pi-permission-system`
  are independent packages from different authors. Nobody merged them.
- **Independent lifecycle.** Either can be toggled off via `--extensions`
  without touching the other. Either can be unit-tested without mocking the
  other's internals.

## Open Questions / Spikes (must resolve before Phase 2 implementation)

These are the parts of the OpenCode guardian design that do **not** map
1:1 onto Pi and need a decision before writing the real extension.

### Q1: How does the hidden reviewer actually get called?

OpenCode's guardian works by opening a second **session on the same running
`opencode serve` HTTP process** and driving it over SSE. Pi has no
persistent server — Quicksave spawns one Pi CLI process per Quicksave
session over stdio RPC (`docs/pi-event-types.md` §3). There is no "second
session on the same server" to open.

Two candidate approaches, need a spike to pick one:

- **A. Second Pi RPC process per review.** Spawn a throwaway `RpcClient`
  (same class `piProvider.ts` already uses to talk to the main session),
  send one `promptAndWait()` with no tools registered and the guardian
  policy as context, parse the response, kill the process. Simple, fully
  isolated (a compromised main session can't touch the reviewer process),
  but pays full process-spawn cost per reviewed tool call — could matter on
  sessions with many rapid tool calls.
- **B. Direct model call via `@earendil-works/pi-ai`.** `pi-agent-plugin-injection.md`
  already lists `@earendil-works/pi-ai` as an importable package from
  inside an extension. If it exposes a raw "call this provider/model with a
  system prompt and get a completion back" function (bypassing the whole
  agent loop), the extension could make one structured-output API call
  directly, reusing the main session's already-configured provider/model.
  Cheaper, no subprocess, but needs confirming this API exists and supports
  structured/JSON-schema output the same way OpenCode's `format:
  json_schema` did.

**Action:** spike both against a real Pi session before committing Phase 2's
design. Prefer B if it exists and supports structured output; fall back to A
otherwise.

### Q2: How does the guardian escalate to the human user?

OpenCode's circuit-breaker escalation reuses Quicksave's existing
`callbacks.handlePermissionRequest` pending-input flow. Pi extensions in
`ctx.hasUI` interactive mode can use `ctx.ui.confirm()`, but Quicksave runs
Pi in **RPC mode**, where `ctx.hasUI` is `false` and those calls are no-ops
(`docs/pi-agent-plugin-injection.md` §RPC Mode Considerations).

`piProvider.ts` today does not handle `extension_ui_request` events at all
(confirmed: zero hits for `extension_ui_request` in the file). Escalation
needs a real channel from "inside the guardian extension" back to
Quicksave's pending-input UI, mirroring how `permission.asked` →
`handlePermissionAsked` works for OpenCode.

**Action:** spike whether `extension_ui_request` (the `confirm` method
specifically) is viable to wire into `piProvider.ts`'s event bridge as a new
case, translating it into the same `handlePermissionRequest` callback
OpenCode uses. If Pi's RPC mode truly drops these requests silently, we may
need a custom command (`pi.registerCommand` doesn't help here since it's
extension-initiated, not host-initiated) or a sideband signal — needs
confirming against Pi's actual RPC behavior, not just the docs.

### Q3: Does the MCP bridge need OAuth / remote transports for v1?

`pi-mcp-extension` supports `stdio`, `streamable-http`, legacy `sse`, and a
full OAuth authorization-code flow for remote servers. Quicksave's current
MCP usage (per `openCodeServer.ts`) is: our own sandbox stdio servers
(`SandboxBash`, `UpdateSessionStatus`, `DisplayMarkdownReport`) plus
whatever the user configures in their own OpenCode/Claude MCP config —
unknown today whether any of those are OAuth-gated remote servers.

**Action:** before Phase 1, check what MCP servers Quicksave users actually
have configured today (grep existing `mcp` config merges, or ask the user).
If it's stdio-only in practice, v1 can skip OAuth and remote transports
entirely and add them later — this cuts the bridge's scope roughly in half
(no `callback-server.ts`/`oauth-provider.ts` equivalent needed).

## Architecture

### Phase 1: MCP Bridge Extension

New file, tentatively `apps/agent/src/ai/piMcpBridge.ts`, injected the same
way as the permission plugin (`docs/pi-agent-plugin-injection.md` Method 1,
`--extensions`).

1. **Config source.** Reuse whatever Quicksave already resolves as "MCP
   servers for this session" today (the same data that feeds OpenCode's
   `mcp` config merge in `openCodeServer.ts`), rather than inventing a new
   `mcp.json` file format. Quicksave owns the config; the extension just
   receives it (likely via a generated per-session config file or CLI arg,
   consistent with how the permission plugin gets its mode — see
   `piProvider.ts` injection pattern).
2. **Client lifecycle.** On `session_start`: for each configured server,
   `new Client()` + `new StdioClientTransport(...)` (pattern already proven
   in `codexMcpProvider.ts`), `client.connect()`, `client.listTools()`.
3. **Schema conversion.** Port (not copy verbatim — MIT-licensed but this is
   a security-adjacent surface, write our own so we own the whole trust
   chain) a JSON-Schema→TypeBox converter modeled on `pi-mcp-extension`'s
   `convertJsonSchemaToTypebox`: handle `$ref`/`$defs`, `oneOf`/`anyOf`/`allOf`,
   enums, nullable, fall back to `Type.Any()` for anything unresolvable.
   `Type.Unsafe()` alone (my first guess, corrected during research) is not
   sufficient — real-world MCP servers use `$ref` and `oneOf` routinely.
4. **Tool registration.** `pi.registerTool()` per MCP tool, name
   `mcp__<server>__<tool>` (reuse Quicksave's existing convention from
   `sandboxMcp.ts`/`openCodeServer.ts` rather than `pi-mcp-extension`'s
   `mcp_<server>_<tool>`, for cross-provider consistency in card rendering).
   `execute()` forwards to `client.callTool()`, converts MCP content blocks
   (text/image/resource) to Pi's `AgentToolResult.content`.
5. **Teardown.** `session_shutdown` → close every `Client`.
6. **Out of scope for v1** (pending Q3): OAuth flow, `streamable-http`/`sse`
   transports, live `notifications/tools/list_changed` refresh, `/mcp`
   management slash commands. Add only if Q3's answer requires them.

### Phase 2: Guardian Extension

New file, tentatively `apps/agent/src/ai/piGuardianExtension.ts`. Depends on
Q1/Q2 being resolved first — the shape of `runReview()` changes materially
depending on which spike answer wins.

1. **Interception.** Single `pi.on("tool_call", ...)` hook
   (`examples/extensions/permission-gate.ts` pattern). Maintain an
   **allowlist** of tool names that skip review (read-equivalents: `read`,
   `grep`, `glob`, `find`, `ls`, `todowrite`/whatever Pi's actual read-only
   tool names are — confirm against Pi's built-in tool list, not assumed
   from OpenCode's). Everything not on the allowlist gets reviewed,
   including any name the allowlist doesn't recognize yet. This is the
   fail-closed inversion of OpenCode's ask-list bug: forgetting to update
   the allowlist means *over*-reviewing, not silently skipping review.
2. **Reviewer call.** Whatever Q1 resolves to. Port `GUARDIAN_POLICY` and
   `GUARDIAN_ASSESSMENT_SCHEMA` from `guardian.ts` near-verbatim — the
   policy wording is provider-agnostic, no OpenCode-specific assumptions in
   the text itself.
3. **Fail-closed + circuit breaker.** Port `OpenCodeGuardian`'s
   `consecutiveDenials`/`shouldEscalateToUser`/`recordUserDecision` logic
   directly — it's pure state-machine logic with no OpenCode API surface,
   should port with near-zero changes.
4. **Escalation.** Whatever Q2 resolves to.
5. **MCP coverage.** No MCP-specific code needed here at all — Phase 1's
   registered tools are ordinary tools to this hook. This is the entire
   point of doing Phase 1 first / as a prerequisite.
6. **Optional, post-MVP:** borrow `pi-permission-system`'s `mcp` surface
   config shape (`"mcp": {"*": "ask", "server:*": "ask", "tool": "allow"}`)
   as a config nicety for per-server/per-tool overrides once the base
   allow/review split works. Not required for the core "review MCP too"
   requirement, which Phase 1 + the default allowlist inversion already
   satisfies.

## Scope

### In Scope (this plan)

- Design + open-question spikes for both extensions.
- Phase 1: MCP bridge for stdio-transport servers, pending Q3.
- Phase 2: Guardian extension ported from `apps/agent/src/ai/guardian.ts`,
  pending Q1/Q2.

### Out of Scope

- The actual decision to migrate off OpenCode to Pi (separate, unrelated
  to this plan — driven by local-model compatibility).
- OAuth / remote MCP transports (deferred to Q3's answer).
- Per-server/per-tool config UI in the PWA (config format TBD once Q1–Q3
  land; likely reuses whatever mechanism already configures OpenCode's MCP
  servers).
- Touching the existing OpenCode guardian or the `write`/`patch` fix
  already shipped in `6b240ef` — this plan does not change OpenCode
  behavior at all.

## Risks

### 1. Q1/Q2 might not have a clean answer

If Pi's RPC mode genuinely has no path for host-initiated confirmation and
`pi-ai` doesn't expose a lightweight completion call, both extensions
become significantly more expensive to build than sketched here (custom
sideband protocol, or accepting the subprocess-per-review cost). Mitigation:
spike before committing to a Phase 2 timeline; this plan intentionally
front-loads the spikes instead of discovering the problem mid-implementation.

### 2. Third-party reference code is not a dependency we should trust blindly

`pi-mcp-extension` and `pi-permission-system` are unaudited community
packages executing arbitrary tool calls. Mitigation: treat them as read-only
reference material for architecture/schema-conversion logic, not as
installable dependencies — write our own implementation so Quicksave owns
the full trust chain for a security-relevant feature.

### 3. Pi's actual built-in tool names/categories are not yet confirmed

The guardian's allowlist (read/grep/glob/etc.) needs Pi's real tool names,
not assumed ports of OpenCode's. Mitigation: confirm against a running Pi
session (`pi --mode rpc` + `get_state`/`get_commands` or equivalent) before
finalizing the allowlist, not from documentation alone.

## Recommended Order

1. Q3 spike (cheap, unblocks Phase 1 scope decision).
2. Phase 1: MCP bridge extension (stdio-only per Q3, most likely answer).
3. Q1 + Q2 spikes in parallel (both are pure research against a live Pi
   process, no product code yet).
4. Phase 2: Guardian extension, built against whichever Q1/Q2 answers won.
5. Integration pass: both extensions loaded together via `--extensions` in
   `piProvider.ts`, confirm MCP-bridged tools go through the guardian with
   no extra wiring (this is the acceptance check for "why two extensions,
   not one").

## Acceptance Criteria

- A Pi session with `auto-review` mode reviews every state-changing
  built-in tool call (write/edit/bash/etc.) through the ported guardian.
- A Pi session with configured MCP servers exposes their tools as normal
  Pi tools, callable by the model.
- Those MCP tool calls are reviewed by the same guardian hook with zero
  MCP-specific code in the guardian extension.
- Read-only tool calls (allowlisted) skip review with zero added latency.
- An unrecognized/new tool name defaults to reviewed, not allowed
  (verifies the fail-closed inversion vs. OpenCode's design).
- Guardian timeout/error still fails closed (deny), matching
  `apps/agent/src/ai/guardian.ts` behavior.
- This plan does not require any change to OpenCode's existing guardian or
  session-listing code.
