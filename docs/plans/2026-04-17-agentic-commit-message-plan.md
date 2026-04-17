# 2026-04-17 Agentic Commit Message Generation Plan

## Summary

Add an alternative commit-message generation source: spawn the user's local Claude Code CLI (`claude -p`) in agentic, read-only mode. Unlike the current Anthropic-SDK flow — which sends a flat, truncated diff — the CLI source runs the full agentic loop, letting the model read related files, grep for callers, and inspect history before writing the commit message.

Uses the user's existing Claude Code subscription, so no additional API key needed for this path.

## Motivation

Current `CommitSummaryService` (`apps/agent/src/ai/commitSummary.ts`) is stateless: it stuffs up to 8 KB of truncated diff into a single Anthropic API call. It cannot:

- Read related files to understand cross-component intent ("this fix changes how X interacts with Y")
- Look at surrounding, non-staged code (e.g. the component being deleted, the caller site)
- Infer project-specific conventions from broader repo context

Running `claude -p` with a read-only tool whitelist gives us the full agentic loop while remaining safe — it can Read/Grep/Glob and run `git diff|log|show|status`, but cannot Write, Edit, or execute arbitrary Bash.

## Architecture

### Keep existing service; add sibling

No refactor of `commitSummary.ts`. Add a sibling class with the same public shape:

```
apps/agent/src/ai/
  commitSummary.ts       (existing — Anthropic SDK, untouched)
  commitSummaryCli.ts    (new — spawns claude -p agentically)
```

Both implement the same `generateSummary(opts): Promise<GenerateSummaryResult>` contract. `handleGenerateCommitSummary` picks one based on the request payload.

### Flow

1. User clicks **Generate** in `CommitForm`.
2. PWA sends `ai:generate-commit-summary` with new field `source: 'api' | 'claude-cli'`.
3. Agent's `handleGenerateCommitSummary` (`apps/agent/src/handlers/messageHandler.ts:848`):
   - `source === 'api'` → existing `CommitSummaryService` path, unchanged.
   - `source === 'claude-cli'` → new `CommitSummaryCliService` path. API key is **not** required for this path.
4. CLI service spawns `claude` with:
   - `-p "<prompt>"` (one-shot, see prompt template below)
   - `--allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*)"`
   - `--output-format json`
   - `--cwd <repo path>`
   - `--model <selected model>` (respect existing Haiku/Sonnet/Opus choice)
   - 60s timeout with SIGTERM on expiry
5. Parse the final `json` frame, extract the last assistant text, then extract the inner `{summary, description}` JSON.

### Prompt template

Crucially, we do **not** inline the diff — the whole point is to let the agent fetch context itself.

```
You are generating a git commit message for staged changes in this repository.

Steps:
1. Run `git diff --cached` to inspect staged changes.
2. If staged changes touch a function, type, or component that is referenced elsewhere,
   briefly inspect those call sites (Grep + Read) to understand intent.
3. If recent commits have a clear style, match it (`git log --oneline -20`).
4. Output ONLY a JSON object on the final line:
   {"summary": "<conventional-commit summary, ≤72 chars>", "description": "<optional body>"}

Guidelines:
- Conventional commits: feat:, fix:, docs:, refactor:, chore:, test:, style:, perf:, ci:, build:
- Focus on WHAT changed and WHY, not HOW
- Be specific but concise
- Do NOT write anything after the JSON object

{optional: user_context}
{optional: branch_name}
{optional: project_conventions}
```

### Output parsing

`claude -p --output-format json` returns a single JSON envelope describing the full turn. We extract the final assistant text block and parse the JSON inside (strip markdown fences if present).

Edge cases → `errorCode` mapping:

| Condition | `errorCode` |
|---|---|
| `claude` binary not found | `NO_CLI_BINARY` |
| CLI exits with auth-required error | `NO_CLI_AUTH` |
| Timeout (60s) | `CLI_TIMEOUT` |
| Cannot parse `{summary,...}` from final message | `CLI_PARSE_ERROR` |
| Other non-zero exit | `CLI_ERROR` |

### Shared types changes

`packages/shared/src/types.ts`:

```ts
export type CommitSummarySource = 'api' | 'claude-cli';

export interface GenerateCommitSummaryRequestPayload {
  context?: string;
  model?: ClaudeModel;
  attribution?: boolean;
  source?: CommitSummarySource; // defaults to 'api' for back-compat
}
```

Add new errorCodes to `GenerateCommitSummaryResponsePayload['errorCode']` union.

### Caching

The existing SDK service caches by `sha256(diff + context + model)`. The CLI source is **not cached**:

- Its output is non-deterministic (agent decides which files to read)
- Even identical diffs may legitimately produce different messages based on exploration
- 30s latency is the expected cost of the "thorough" option

### UI changes — `CommitForm.tsx`

Minimal UI churn: add a small source toggle next to the existing model dropdown.

```
[Model ▾] [Source: API / Claude CLI] [      Generate      ]
```

- When `source === 'claude-cli'`:
  - `apiKeyConfigured` gate is lifted (CLI doesn't need it)
  - Loading text becomes `"Exploring repo..."` (vs. `"Generating commit message..."`)
- Source preference persisted in `gitStore` (same tier as `selectedModel`).
- Future: auto-hide CLI option if `claude` binary missing (probe via existing `findClaudeBinary`). V1 just fails loud.

## Implementation phases

### Phase 1 — Shared types + backend

1. Add `CommitSummarySource` type and new `errorCode` values to `packages/shared/src/types.ts`.
2. Add `source` field to `GenerateCommitSummaryRequestPayload`.
3. Create `apps/agent/src/ai/commitSummaryCli.ts`:
   - Resolve `claude` binary (reuse helper from `claudeCliProvider.ts` if trivially exportable; else inline minimal copy).
   - `spawn` with arg list above; kill on 60s timeout.
   - Parse `--output-format json` output, extract final text, parse inner JSON.
   - Map exit codes → `errorCode`.
   - Respect `attribution` flag (append `Commit-message-by: Quicksave AI` trailer).
4. Update `handleGenerateCommitSummary` (`messageHandler.ts:848`):
   - Branch on `payload.source`.
   - Skip `NO_API_KEY` check when `source === 'claude-cli'`.
   - Still pass existing context (recent commits, branch, conventions) into the prompt template for the CLI path, but let the agent verify/expand via tools.

### Phase 2 — Tests (in same pass as code, per CLAUDE.md)

5. `apps/agent/src/ai/commitSummaryCli.test.ts`:
   - Mock `child_process.spawn`.
   - Assert correct args (including allowedTools whitelist).
   - Test JSON output parsing (bare JSON, markdown-fenced JSON, trailing whitespace).
   - Test each error mapping (binary-not-found, auth error, timeout, parse error).
   - Test attribution trailer is appended.

### Phase 3 — Frontend

6. Add `commitSummarySource` (default `'api'`) to `gitStore`, persisted like `selectedModel`.
7. Thread the field through `useGitOperations` / wherever `generateAiSummary` dispatches.
8. `CommitForm.tsx`:
   - Add source toggle UI component (small segmented control next to model dropdown).
   - Conditional gating: CLI path doesn't require `apiKeyConfigured`.
   - Loading copy switches based on source.

### Phase 4 — Docs

9. Update `docs/references/quicksave-architecture.md`:
   - Mention the two sources in the commit-summary section.
   - Note CLI path does not require an API key.
10. This plan doc itself (Status: Implemented) once shipped.

## Out of scope (future work)

- **Codex CLI source** — architecture supports it trivially (`commitSummaryCodex.ts` sibling with `-s read-only --output-schema`). Hold until Claude CLI path is proven useful.
- **Streaming progress events** — showing which files the agent is reading. Nice-to-have; gated on whether `claude -p --output-format stream-json` is worth adopting over the simpler one-shot `json` format.
- **Per-repo source preference** — start with a single global preference.
- **Auto-detect Claude CLI availability** — first release just fails loud with `NO_CLI_BINARY`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agentic exploration can take 10-30s | Loading UX makes it explicit ("Exploring repo..."); 60s hard timeout |
| Higher token cost vs. flat-diff API call | User pays via their own Claude subscription; no direct Quicksave cost. Explicit opt-in per generation. |
| CLI flag drift between versions | One-shot `-p` + `--allowedTools` + `--output-format json` have been stable. Fail-loud on parse error rather than silent fallback. |
| Agent might invoke a disallowed tool and get stuck | `--allowedTools` whitelist denies without prompting (no `--permission-prompt-tool stdio`, so no stdin round-trip expected). Timeout catches any stuck state. |
| Non-deterministic output breaks existing cache assumptions | CLI path bypasses cache entirely. |

## Acceptance criteria

- Clicking Generate with source = Claude CLI on a staged change produces a commit message within 60s.
- The generated message reflects awareness of files beyond the staged diff (verify manually on a cross-component refactor).
- Missing `claude` binary / unauthenticated CLI returns the correct `errorCode` and a readable error in the UI.
- Existing API-key flow is unchanged (no regressions in `commitSummary.test.ts` if it exists, or equivalent integration test).
- `cd apps/agent && npx vitest run` passes.
- `cd apps/pwa && npx tsc --noEmit` passes.
