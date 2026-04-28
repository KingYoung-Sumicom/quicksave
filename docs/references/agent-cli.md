# Agent CLI reference

Complete reference for the `quicksave` command, the daemon it manages,
and the on-disk state layout.

## Subcommands

| Command                          | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `quicksave`                      | Start / ensure daemon; print pairing URL + QR                |
| `quicksave rotate-keys`          | Generate a new keypair (invalidates paired PWAs)             |
| `quicksave service start`        | Start daemon in the background                               |
| `quicksave service stop`         | Stop the running daemon                                      |
| `quicksave service status`       | Live status (pid, peers, active sessions, managed repos)     |
| `quicksave service info`         | Static status from `service.json` (no IPC)                   |
| `quicksave service run`          | Run daemon in foreground (not normally invoked directly)     |

### Flags accepted by `quicksave`

```bash
quicksave                                  # cd into a git repo first
quicksave --repo /path/to/repo             # explicit repo path
quicksave -s wss://your-relay.example.com  # custom signaling server
```

## Debug commands

Available only when `QUICKSAVE_DEBUG=1` is set (auto-enabled in dev mode):

```bash
QUICKSAVE_DEBUG=1 quicksave service debug          # full state snapshot
QUICKSAVE_DEBUG=1 quicksave service sessions       # list all coding-agent sessions
QUICKSAVE_DEBUG=1 quicksave service cards <id>     # card history for a session
QUICKSAVE_DEBUG=1 quicksave service resolve <id>   # force-resolve stuck permission
```

For the full IPC method reference (debug HTTP server + debug CLI bridge),
see [`quicksave-architecture.md`](./quicksave-architecture.md) §七.

## What the daemon does

- Maintains the WebSocket connection to the relay, does NaCl handshake
  with each paired PWA, and decrypts/dispatches every message.
- Executes git operations against managed repos (`status`, `diff`, stage,
  unstage, commit, branch, log, `.gitignore` edits, etc.).
- Manages coding-agent CLI sessions: spawns the agent CLI with stream-json
  I/O, parses the output into `Card` events, handles `control_request`
  permission prompts, forwards them to the PWA for approval, and streams
  card updates back.
- Generates commit messages either via Anthropic API (user-supplied key)
  or via an agentic `claude -p` loop that uses the user's local Claude
  subscription.
- Hosts a pool of PTY-backed interactive shells
  (`src/terminal/terminalManager.ts`, via `node-pty`) that the PWA can
  drive remotely. Each terminal keeps a bounded scrollback buffer so a
  reconnecting PWA can redraw the current screen without the shell having
  to repaint.
- Serves an IPC (Unix socket) JSON-RPC API for the CLI to query state
  and issue debug commands.
- Triggers Web Push notifications through the relay when a permission
  prompt arrives and no PWA peer is currently subscribed.

## Data location

| Path                            | Contents                                          |
| ------------------------------- | ------------------------------------------------- |
| `~/.quicksave/config.json`      | Agent ID, NaCl keypairs, managed repo list        |
| `~/.quicksave/run/service.json` | Live daemon state (pid, socket path, heartbeat)   |
| `~/.quicksave/run/*.sock`       | IPC socket                                        |
| `~/.quicksave/sessions/`        | Per-session JSONL history                         |
