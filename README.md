# Quicksave

Remote-control your dev machine from a phone. Review diffs, stage, commit,
and drive Claude Code CLI sessions — end-to-end encrypted, with a dumb
relay in the middle that can't read your code.

## How it works

```
┌────────────┐    WebSocket    ┌───────────┐    WebSocket    ┌──────────────┐
│  PWA       │ ◄─────────────► │  Relay    │ ◄─────────────► │  Agent       │
│ (browser)  │   (encrypted)   │ (stateless)│  (encrypted)   │ (your laptop)│
└────────────┘                 └───────────┘                 └──────────────┘
```

- **PWA** — React app (`apps/pwa`), hosted at [quicksave.dev](https://quicksave.dev) or self-hostable.
- **Agent** — Node.js daemon (`apps/agent`), installed globally via `npm install -g @sumicom/quicksave`. Runs git, manages Claude Code sessions, holds the NaCl keys.
- **Relay** — Minimal Node server (`apps/relay`). Routes encrypted frames, serves an in-memory sync blob store, fans out Web Push. Never sees plaintext.

All three endpoints share a small set of TypeScript packages:

- [`@sumicom/quicksave-shared`](./packages/shared) — wire types, NaCl crypto, card model
- [`@sumicom/quicksave-message-bus`](./packages/message-bus) — command + subscribe RPC over any transport

## Quick start

### 1. Install the agent on your dev machine

```bash
npm install -g @sumicom/quicksave
cd /path/to/your/repo
quicksave
```

This prints a pairing URL and QR code and keeps a background daemon
running. See [`apps/agent/README.md`](./apps/agent/README.md) for the full
CLI reference.

### 2. Connect the PWA

Open [quicksave.dev](https://quicksave.dev) on your phone and scan the QR
code. Everything from this point on is E2E encrypted.

## Monorepo layout

```
apps/
├── agent/        # Desktop daemon (npm: @sumicom/quicksave)
├── pwa/          # React PWA
└── relay/        # WebSocket relay server
packages/
├── shared/       # (npm: @sumicom/quicksave-shared)
└── message-bus/  # (npm: @sumicom/quicksave-message-bus)
docs/
├── guidelines.md            # Engineering + design guidelines index
├── guidelines/              # Individual guideline docs
├── plans/                   # Feature / implementation plans
├── references/              # Deep technical references (see below)
└── relay/                   # Relay protocol & deployment docs
```

Each `apps/*` and `packages/*` has its own README with package-specific
details.

## Architecture

The source-of-truth architecture document is
[`docs/references/quicksave-architecture.md`](./docs/references/quicksave-architecture.md).
It covers:

- Session lifecycle across `SessionManager` / `ClaudeCliProvider`
- MessageBus paths (`/sessions/active`, `/sessions/:id/cards`, `/preferences`, …)
- End-to-end encryption and handshake flow
- Web Push side channel
- IPC / debug CLI

> The old `ARCHITECTURE.md` at the repo root predates the current relay /
> MessageBus design and is kept only for historical reference. Prefer the
> doc above.

## Development

```bash
pnpm install                  # installs everything + sets up git hooks

pnpm dev                      # vite dev server (PWA) on :5173
pnpm dev:relay                # standalone relay on :8080
pnpm dev:agent -- --repo /path/to/repo -s ws://localhost:8080

pnpm -r test                  # run all test suites
pnpm -r typecheck             # typecheck everything
pnpm -r build                 # build everything
```

Per-app commands (e.g. `pnpm --filter @sumicom/quicksave test`) are
documented in each package's README.

### Self-restart during agent dev

```bash
./scripts/dev-daemon.sh            # kill + respawn daemon from source
./scripts/dev-daemon-delayed.sh 30 # delayed variant; safe from inside a
                                   # daemon-spawned Claude CLI
```

## Self-hosting

The relay and PWA are both self-hostable:

### Relay

```bash
docker build -f apps/relay/Dockerfile -t quicksave-relay .
docker run -p 8080:8080 quicksave-relay
```

Put it behind a TLS-terminating reverse proxy. Set `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` to enable Web Push. See
[`docs/relay/deployment.md`](./docs/relay/deployment.md) for the full
checklist.

### PWA

```bash
QUICKSAVE_SIGNALING_URL=wss://your-relay.example.com pnpm build:pwa
# deploy apps/pwa/dist/ to any static host
```

## License

MIT
