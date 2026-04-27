# Codex app-server schema — vendored subset

These TypeScript files are a hand-curated subset of the output of:

```
codex app-server generate-ts --out DIR
```

Pinned codex CLI version: **0.125.0** (see `../version.ts`).

**Do not edit by hand.** To resync after a codex CLI bump, run:

```
pnpm --filter @sumicom/quicksave run regen-codex-schema
```

The script lives at `apps/agent/scripts/regen-codex-schema.sh` and
copies only the whitelisted files. Anything outside the whitelist is
intentionally dropped to keep the surface reviewable.

Authoritative wire-method tables (don't depend on the README — read
these):

- `ServerNotification.ts` — every notification method the server
  emits.
- `ServerRequest.ts` — every request the server may initiate.
- `ClientRequest.ts` — every request the client may send.
- `ClientNotification.ts` — every notification the client may send.

For payload-shape diffs across CLI versions, run regen and review the
git diff in the same PR as the version bump.
