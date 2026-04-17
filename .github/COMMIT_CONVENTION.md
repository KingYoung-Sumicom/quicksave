# Quicksave commit conventions

These are deltas on top of the generator's default Conventional Commits rules
(see `docs/guidelines/commits.md`). Defaults still apply where this file is
silent.

## Scope vocabulary (required when scope is included)

Use exactly one of these scopes; don't invent new ones. If a change touches
two or more of these areas, OMIT the scope entirely (do not write
`feat(agent,pwa):` or `feat(repo):`).

- `agent` — anything under `apps/agent/**`
- `pwa` — anything under `apps/pwa/**`
- `relay` — anything under `apps/relay/**`
- `shared` — anything under `packages/shared/**`
- `docs` — only `docs/**` (paired with `docs:` type, in which case the scope is
  redundant and may be omitted)

Cross-area changes (≥2 of the above): no scope. Root-level config, scripts,
CI, release plumbing: no scope.

## Body required for

- Anything that adds or changes a WebSocket message type
  (`packages/shared/src/types.ts`).
- Anything that changes `MessageHandler` routing or `CLISessionRunner`
  lifecycle.
- Anything that touches encryption / key exchange (`apps/agent/src/connection`).
- Migrations to persisted stores (`machineStore`, `connectionStore`,
  `commitSummaryStore`, `eventStore`).

In each case, name the affected protocol field / store key in the body.

## Footers

- Don't add `Closes:` / `Refs:` unless the user context explicitly mentions a
  ticket. We don't backfill issue numbers.
- The auto `Commit-message-by:` and `Generated-by:` trailers are added by the
  agent — don't duplicate them.
