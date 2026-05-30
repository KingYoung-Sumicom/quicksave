# Quicksave Shared Agent Instructions

## Guidelines

Before designing or implementing features, consult `docs/guidelines.md` for an index of design and engineering guidelines. Each entry points to a detailed document.

## Standing Project Knowledge

- Communicate with the user in Traditional Chinese. The user also understands Japanese, but does not understand Korean; do not reply in Korean.
- For attachments, file previews, screenshots, or any large per-item bytes, snapshots and lists should carry metadata only. Fetch bytes on demand by id and reuse the shared PWA cache machinery instead of embedding base64/blob data inline.
- Claude session history is reconstructed from `.claude/projects/...` JSONL through `apps/agent/src/ai/cardBuilder.ts`. Keep raw Claude JSONL reading centralized there unless a broader architecture change explicitly moves that responsibility.
- Quicksave daemon runtime paths: log `~/.quicksave/run/daemon.log`, state `~/.quicksave/state/service.json`, socket `~/.quicksave/run/service.sock`, lock `~/.quicksave/run/service.lock`, config `~/.quicksave/agent.json`.
- When restarting the daemon from inside a daemon-spawned agent session, prefer `scripts/dev-daemon-delayed.sh` so the current conversation is not killed by the daemon restart. Preserve its explicit `bash scripts/dev-daemon.sh` invocation because `scripts/dev-daemon.sh` is tracked without an executable bit.
- Refactor priority should be based on change spread and change frequency, not lines saved. Prefer reducing patterns that force edits across many files.
- When a UI fix creates a reusable rule, record it in the appropriate guideline document linked from `docs/guidelines.md`, with the reason, so the rule does not get buried in a one-off plan.

## Documentation Sync Pointers

**After every non-trivial code change, check whether one of these docs
needs to be updated in the same commit.** Pull the file in only when
your change actually touches its scope; do not read them speculatively.

| If you change...                                                   | Also update...                                     |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| Any app or package structure (`apps/*`, `packages/*` added/removed) | `docs/references/quicksave-architecture.en.md` + root `README.md` |
| `packages/shared/src/types.ts` message types                       | `docs/references/quicksave-architecture.en.md` section four |
| Add a new PWA -> Agent request/response verb                       | `messageHandler.ts` switch + `handlers/legacyBusAdapter.ts` `LEGACY_BUS_VERBS` allowlist (both required, see architecture section three Command adapter gotcha) |
| `apps/agent/src/handlers/messageHandler.ts` routing                | `docs/references/quicksave-architecture.en.md`      |
| `SessionManager` / `CodingAgentProvider` / new AI provider         | `docs/references/quicksave-architecture.en.md` section two |
| Add a new `AgentId` (coding-agent provider)                        | `packages/shared` `AgentId` union + `sessionManager.ts` `normalizeAgentId` allowlist (omitting it makes cold-resume downgrade the session to the default agent) + `apps/pwa` `agentProvider.tsx` `PROVIDER_INSTANCES` |
| `AgentConnection` encryption / pubsub                              | `docs/references/quicksave-architecture.en.md` section three |
| PWA <-> PWA sync mailbox, Ed25519 envelope, TOFU pin, tombstone flow | `docs/guidelines/sync-security.en.md` + `docs/references/quicksave-architecture.en.md` section three |
| PWA store shape or hook API                                        | `docs/references/quicksave-architecture.en.md` section six |
| CLI commands, daemon IPC methods, debug commands, or env vars in `apps/agent` | `docs/references/agent-cli.md`           |
| Dev scripts (`scripts/dev-daemon*.sh`), monorepo dev workflow, dev tunneling | `docs/development.md`                       |
| `apps/pwa` build flags, dev workflow, or stack                     | `apps/pwa/README.md`                             |
| Relay env vars, HTTP routes, or deployment steps                   | `apps/relay/README.md` + `docs/relay/*`          |
| `packages/message-bus` public API (server/client/transport types)  | `packages/message-bus/README.md`                 |
| `packages/shared` public entrypoints or module layout              | `packages/shared/README.md`                      |
| Anything published to npm (versioning, bin, exports)               | that package's `README.md` + root `README.md` quick-start |

The per-package READMEs stay short; the deep reference is always
`docs/references/quicksave-architecture.en.md`. Expand only the specific
doc(s) your change touches.

## Git

- By default the user handles git themselves; do not run git commands (`add`, `commit`, `push`, etc.) on your own initiative.
- If the user explicitly asks you to run a specific git operation, stay within that scope and do not escalate to further git actions without another explicit ask.
- A pre-push hook (`scripts/pre-push`) auto-installs via `pnpm install` by setting `core.hooksPath`.
  - Protected branches (`main`, `stable`, `staging`) and tags: clean worktree build and test.
  - Other branches: fast local build and test.

## Project

- Monorepo: `apps/agent`, `apps/pwa`, `apps/relay`, `packages/shared`
- Agent tests: `cd apps/agent && npx vitest run`
- Agent coverage: `cd apps/agent && npx vitest run --coverage`
- PWA type-check: `cd apps/pwa && npx tsc --noEmit`

## Testing

See `docs/guidelines/testing.md` for full testing guidelines.

**Key rule:** Write tests in the same pass as the code, not as a separate batch later. When implementing a feature or fixing a bug in `apps/agent`, write or update the corresponding tests before considering the task done.
