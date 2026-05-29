# Quicksave Shared Agent Instructions

## Guidelines

Before designing or implementing features, consult `docs/guidelines.md` for an index of design and engineering guidelines. Each entry points to a detailed document.

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
