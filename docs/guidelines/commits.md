# Commit Message Conventions

Quicksave's commit summary generator (`apps/agent/src/ai/commitSummary*.ts`) ships with a default Conventional Commits prompt that any project can adopt as-is. Per-project overrides plug in on top.

## Default format (built into the prompt)

```
<type>(<scope>): <subject>

[body]

[footers]
```

**Type** (required) — one of: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `style`, `perf`, `ci`, `build`.

**Scope** (optional, recommended) — one short noun naming the area touched.
- Inferred from the staged file paths' common prefix (top-level dir, package, or module).
- Omitted when changes span multiple unrelated areas.
- Lowercase, hyphenated; no commas, no slashes.

**Subject** (`summary` field):
- ≤72 chars including the `<type>(<scope>): ` prefix.
- Imperative present tense ("add X", not "added"/"adds").
- No trailing period. Lowercase first word after the colon (unless proper noun).

**Body** (`description` field, rendered after a blank line):
- Wrap lines at 72 chars.
- Blank line between paragraphs; `- ` bullets for multi-aspect changes.
- Required when behavior changes, multiple modules touched, motivation non-obvious, or migration needed.
- Omitted only for truly trivial changes (typo, dependency bump, single-line tweak).

**Footers** (appended to body after a blank line, one trailer per line):
- `BREAKING CHANGE: <what broke and how to migrate>` for breaking API/behavior changes.
- `Refs: #123` / `Closes: #123` only when the diff or user context provides evidence — the generator must not invent issue numbers.

The generator also auto-appends an attribution trailer (`Commit-message-by: Quicksave AI <save@quicksave.dev>`) unless the caller passes `attribution: false`.

## Per-project overrides

Any repository can ship a convention file at one of these paths (checked in order); the agent reads the first match (`apps/agent/src/git/operations.ts:readCommitConventions`):

1. `.github/COMMIT_CONVENTION.md`
2. `.github/commit-convention.md`
3. `CONTRIBUTING.md`
4. `contributing.md`

The first 2000 chars of the file are appended to the prompt under a section that **explicitly tells the LLM to override the defaults where they conflict** — e.g. allowed scope vocabulary, custom types, different subject length, mandatory trailers.

Use a project file to:
- Pin a finite scope vocabulary (especially for monorepos — see `.github/COMMIT_CONVENTION.md` in this repo for an example).
- Require / forbid specific types.
- Tighten or relax subject length.
- Require project-specific footers (e.g. ticket prefix).

Don't rewrite the format from scratch in the override — only state the deltas.

## How recent commits feed in

`recentCommits` (last 10 by default) is also appended to the prompt as "Recent commits (match this style)". Even with no convention file, the LLM picks up on the project's prevailing pattern (scope words, subject phrasing) by example. The convention file is needed only when you want to *enforce* something the existing history doesn't already demonstrate.

## When to update this doc

Update this file when:
- Changing the default prompt rules in `commitSummary.ts` / `commitSummaryCli.ts`.
- Adding/removing convention file paths in `readCommitConventions()`.
- Changing the auto-attribution trailer behavior.
