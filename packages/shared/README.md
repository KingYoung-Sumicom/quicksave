# @sumicom/quicksave-shared

Shared TypeScript types, crypto utilities, and wire-format helpers used by
all three Quicksave apps (`agent`, `pwa`, `relay`). Not intended for
external consumption — it's published so the agent and PWA can depend on it
via the normal npm resolution, not because it has a stable standalone API.

## Modules

| Entry                         | Contents                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `@sumicom/quicksave-shared`   | Everything (re-exports all of the below)                                   |
| `.../crypto`                  | NaCl box/sign wrappers, gzip+encrypt envelope helpers                      |
| `.../protocol`                | `Message` envelope helpers, handshake types, message-type narrowing        |

## What lives here

- **`types.ts`** — the canonical `MessageType` enum and every payload /
  response type exchanged between PWA and agent (`claude:*`, `git:*`,
  `agent:*`, `ai:*`, `push:*`, etc.). This is the wire contract.
- **`cards.ts`** — `Card` / `CardEvent` data model used for streamed
  assistant output (user text, assistant text, thinking, tool calls,
  subagent blocks, system). Consumed by `StreamCardBuilder` in the agent
  and by `CardRenderer` in the PWA.
- **`crypto.ts`** — X25519 + XSalsa20-Poly1305 box for E2E message
  encryption; Ed25519 for signed HTTP calls to the relay's push routes;
  gzip+encrypt envelope used for all wire messages.
- **`protocol.ts`** — helpers for building and parsing the `Message<T>`
  envelope that wraps every request, response, and push.
- **`permissions.ts`** — permission-mode enum (`bypassPermissions`,
  `acceptEdits`, `default`, `plan`) and per-mode auto-approve tables.
- **`defaults.ts`** — default signaling URL and other shared constants.

## Wire contract note

Anything added to or changed in `MessageType` in `types.ts` is a protocol
change — both the agent's `MessageHandler` and the PWA hooks
(`useClaudeOperations`, `useGitOperations`) must be updated at the same
time. See `docs/references/quicksave-architecture.en.md` §四 for the full
message-type catalog and bus-path mappings.

## License

MIT
