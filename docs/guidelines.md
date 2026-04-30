# Guidelines Index

Before designing or implementing any feature, check the relevant guidelines below.

---

## System Architecture

**`docs/references/quicksave-architecture.en.md`** — Full system architecture reference. Covers:
- Monorepo structure and per-app responsibilities
- Agent daemon startup sequence, session lifecycle, and event system
- E2E encrypted transport and the PubSub mechanism
- WebSocket message protocol and naming conventions
- PWA state management and component hierarchy
- End-to-end data flow

**Maintenance rule**: when changing any of the following, also update `docs/references/quicksave-architecture.en.md`:
- Adding or removing an app or package
- Changing a WebSocket message type (`packages/shared/src/types.ts`)
- Changing `MessageHandler` routing logic
- Changing the `CLISessionRunner` session lifecycle or events
- Changing `AgentConnection` encryption or PubSub mechanism
- Changing PWA store state shape or hook API
- Adding or removing an AI provider

---

## UI / UX Design

**`docs/plans/ui-design-rules.md`** — Rules derived from past fixes. Covers:
- Root container must use `overflow-hidden` (virtual keyboard layout)
- `interactive-widget=resizes-content` in viewport meta
- No vertical scrolling inside chat view elements (nested scroll breaks touch)
- Chat view components must not use `max-h-*` + `overflow-y-auto`
- No scrollbars anywhere inside the chat view — let content expand, let the messages list scroll
- All Enter-to-submit must guard IME composition (`!e.nativeEvent.isComposing`)

---

## Component Design & Refactoring

**`docs/plans/component-refactoring-guidelines.en.md`** — Targets and rules for splitting reusable components. Covers:
- When to split (Rule of Three, 300+ line threshold)
- File organization (`ui/`, `hooks/`, `chat/`)
- High priority: Collapsible, Modal, useLongPress, loading-state components
- Medium priority: FormField, StatusBadge, IconButton, ToolViewHeader
- Large-component split targets (ToolCallMessage, SettingsPanel, ClaudePanel, NavigationDrawer, FileList)

**Maintenance rule**: after completing a split, update the guideline doc to mark it done and record the actual file paths.

---

## Commit Messages

**`docs/guidelines/commits.md`** — Commit message format used by the AI commit summary generator. Covers:
- Default Conventional Commits format baked into the prompt
- How per-project overrides plug in (`.github/COMMIT_CONVENTION.md`, `CONTRIBUTING.md`, etc.)
- How `recentCommits` / `branchName` / `userContext` feed the prompt
- This repo's own scope vocabulary lives in `.github/COMMIT_CONVENTION.md`

**Maintenance rule**: update this doc in the same change when modifying the prompt in `commitSummary.ts` / `commitSummaryCli.ts`, adding or changing convention-file lookup paths, or changing attribution-trailer behavior.

---

## Testing

**`docs/guidelines/testing.md`** — Testing guidelines and procedures. Covers:
- Core principle: write tests alongside code, not as a separate batch
- Agent test structure, running, and mocking patterns
- Adversarial / edge-case testing for race conditions and reconnect bugs
- Continuous process refinement: evolve testing practices when bugs are found
- Coverage targets and priority modules

**Maintenance rule**: when a new bug pattern is found, update the testing guidelines to record the corresponding test strategy.

---

## PWA ↔ PWA Sync Security

**`docs/guidelines/sync-security.en.md`** — Security design for syncing "device / account settings" across multiple PWA clients. Covers:
- Threat model (single user, relay shared across users, `masterSecret` leak = full compromise)
- Identity model: all PWAs share `masterSecret`; X25519 / Ed25519 keypairs are derived from it (no per-PWA crypto identity, no allowlist)
- Single-slot mailbox + read-modify-write + per-mailbox in-flight mutex + LWW convergence
- `SignedSyncEnvelope` schema and Ed25519 verification on the relay
- PWA pairing: A emits QR + deep-link URL (`#k=<eA_pub>` fragment) + multi-slot mailbox simultaneously; B shows a 6-character SAS (32-symbol alphabet); A filters candidates by input
- **Agent trust model**: TOFU-pin a single PWA pubkey, subscribe to `tombstone:*` pubsub, on tombstone auto-wipe and enter lockout mode, requires CLI `quicksave pair` to unlock
- Decommission (clear browser storage) vs. group reset (tombstone + rotate `masterSecret` + agent auto-wipe)
- Difference from Happy Coder (Quicksave keeps the relay stateless; the agent does not hold `masterSecret`)

**Maintenance rule**: update this doc in the same change when modifying sign/verify/encrypt/seed-keypair/SAS derivation in `packages/shared/src/crypto.ts`, slot/mutex logic in `apps/relay/src/syncStore.ts`, the `/pair-requests/*` lifecycle in `apps/relay/src/pairStore.ts`, the envelope schema in `apps/pwa/src/lib/syncClient.ts` or `syncMerge.ts`, the SAS pairing flow in `apps/pwa/src/lib/pairClient.ts`, the `peerPWA*` fields in `apps/agent/src/config.ts`, the handshake pubkey check or lockout mode in `apps/agent/src/connection/connection.ts`, or group reset / tombstone pubsub broadcasts.

---

## Sandbox Mode

**`docs/guidelines/sandbox-mode.md`** — Kernel-level sandbox that coding-agent sessions run under by default. Covers:
- `DEFAULT_SANDBOXED = true`, per-session override persisted on `SessionRegistryEntry`
- Filesystem write confinement to the project `cwd` + `SandboxBash` auto-approval
- Runtimes (`sandbox-exec` on macOS, `bwrap` on Linux) and the SBPL profile location
- When to turn sandbox OFF and the associated trade-offs
- Pointers to the default, the stdio MCP server, the provider wiring, and the PWA toggles

**Maintenance rule**: update this doc when changing `DEFAULT_SANDBOXED`, the supported sandbox backends, the `SandboxBash` tool name / parameters / auto-approval hook, the SBPL profile strategy, or the location of the PWA sandbox toggle.

---

## Session Settings Persistence

All user-facing session settings (e.g. `permissionMode`, `sandboxed`) **must** be persisted in `SessionRegistryEntry` so they survive daemon restarts.

**Rule**: When adding a new session setting:
1. Add the field to `SessionRegistryEntry` in `packages/shared/src/types.ts`
2. Persist it in `messageHandler.ts` when creating the registry entry (both `handleClaudeStart` and `handleClaudeResume`)
3. In `sessionManager.resumeSession`, fall back to the registry value when the in-memory map is empty
4. In `sessionManager.setSessionConfig`, persist changes via `persistRegistryField`

**Why**: In-memory maps (`sessionPermissions`, `sessionSandboxed`, `sessionConfigs`) are cleared on daemon restart. Without registry persistence, resumed sessions lose their settings.

---
