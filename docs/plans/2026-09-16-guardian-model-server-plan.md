# Guardian: User-Supplied Model Server Instead Of A Hidden OpenCode Session

**Date:** 2026-09-16
**Status:** Implemented

## Summary

`apps/agent/src/ai/guardian.ts` currently reviews tool calls by opening a
hidden OpenCode session (`quicksave-guardian`) on the same `opencode serve`
process, locking its tools to nothing via a permission ruleset, and driving
it over SSE until a `StructuredOutput` tool call arrives. This works, but
has three problems found while researching Pi's guardian equivalent:

1. **Session leak.** The hidden session is only deleted by
   `OpencodeSession.kill()` → `disposeGuardian()`, and `kill()` is only
   called from `SessionManager.cleanup()` — the daemon's *shutdown* path,
   not per-session-end. Any main session that ends without a clean daemon
   shutdown (the common case), or any daemon crash, leaves the guardian
   session orphaned in OpenCode's own session store forever. There is no
   reconciliation sweep to find and delete these later.
2. **Coupled to OpenCode's session/SSE machinery**, which means the same
   design cannot be reused for a Pi (or Codex, or Claude) guardian without
   re-solving "how do I get a tool-free structured completion out of this
   provider" per provider. Pi's equivalent (`docs/plans/2026-09-16-pi-guardian-mcp-bridge-plan.md`,
   Q1) was stuck on exactly this: Pi has no persistent server to open a
   second session on, and its tool-free `generate.text()`-equivalent API
   does not exist yet on any released version.
3. **Reviewer model is whatever the main session is using.** A local model
   reviewing tool calls it just generated itself is a weak safety boundary.

## Decision

The guardian reviewer calls a **user-configured, OpenAI-compatible model
server directly** (raw `POST {baseUrl}/chat/completions`), instead of
opening any session on the coding-agent provider at all.

This is a prerequisite for `auto-review` mode, not an optional override:
if no guardian model server is configured, `auto-review` is unavailable
(fails closed at admission, not silently falls back to the main session's
model).

Consequences:

- No OpenCode (or Pi, or Codex) session is ever created for review. The
  session-leak problem is eliminated at the source, not mitigated.
- The reviewer-call mechanism becomes provider-agnostic. Only the
  *context-gathering* step (reading the main session's recent
  messages/tool calls) stays per-provider, because that has to read each
  provider's own message format.
- Resolves Pi plan Q1 without a spike: the ported Pi guardian extension can
  reuse the same model-server client instead of needing a second Pi
  process or `pi-ai`.
- User can point the reviewer at a different/stronger model than the main
  session, independent of which coding-agent CLI or local model is driving
  the actual work.

## Scope

### In Scope

- `apps/agent/src/config.ts`: guardian model server config (`baseUrl`,
  `apiKey?`, `model`), env-var based to match the existing guardian config
  pattern (`QUICKSAVE_GUARDIAN_MODEL`/`_TIMEOUT_MS`/`_MAX_CONSECUTIVE` are
  already env vars, not `AgentConfig` fields).
- New `apps/agent/src/ai/guardianModelClient.ts`: minimal OpenAI-compatible
  chat-completions client (structured output via `response_format:
  json_schema` when possible, plain text otherwise — `parseGuardianAssessment`
  already tolerates both).
- `guardian.ts` refactor: remove `ensureSession`/`GUARDIAN_SESSION_TITLE`/
  `GUARDIAN_OWNER_METADATA_KEY`/SSE-subscription reviewer path. Keep
  `buildContext()` (still reads the main session via `server.getMessagePage`),
  `GUARDIAN_POLICY`, `GUARDIAN_ASSESSMENT_SCHEMA`, fail-closed timeout, and
  circuit-breaker logic unchanged.
- `openCodeProvider.ts`: gate `auto-review` permission level on the model
  server being configured; construct `OpenCodeGuardian` with the model
  server config instead of an optional model override.
- Tests updated alongside (`guardian.test.ts`, `openCodeProvider.test.ts`).

### Out of Scope (this change)

- PWA settings UI for the guardian model server (env-var only for v1,
  matching how the rest of the guardian config already works).
- The Pi guardian extension itself (still tracked in the Pi plan; this
  change only removes one of its open questions).
- A reconciliation sweep for *already-orphaned* guardian sessions from
  before this change ships. Worth doing separately as cleanup, but it is
  no longer load-bearing for preventing new leaks.

## Acceptance Criteria

- `auto-review` permission level is rejected with a clear, actionable error
  when no guardian model server is configured.
- A reviewed tool call never causes a new session to appear in
  `opencode serve`'s session store.
- `guardian.ts` has no remaining dependency on `OpenCodeServer` session
  methods (`createSession`, `deleteSession`, `subscribe`, `sendPromptAsync`,
  `abortSession`) for the review call itself — only `getMessagePage` for
  context.
- Existing fail-closed/circuit-breaker/timeout behavior is unchanged from
  the caller's perspective (`openCodeProvider.ts`'s `handleAutoReviewPermission`
  does not need logic changes, only construction-site changes).
- All existing guardian + openCodeProvider tests pass, updated to mock an
  HTTP model server instead of a scripted OpenCode session.
