# Quicksave

Remote git control PWA with end-to-end encryption. Control your computer's git working tree from your phone.

## Features

- **Review changes** - View diffs on mobile
- **Stage & unstage** - Prepare commits on the go
- **Commit** - Write commit messages from anywhere
- **E2E encrypted** - All data encrypted between devices
- **Privacy first** - We can't see your code

## Quick Start

### 1. Install the Desktop Agent

```bash
# Install globally
npm install -g @quicksave/agent

# Run in your git repository
cd /path/to/your/repo
quicksave-agent
```

### 2. Connect from PWA

1. Visit [quicksave.dev](https://quicksave.dev) on your phone
2. Scan the QR code or enter connection details
3. Start reviewing and committing!

## Development

```bash
# Install dependencies
pnpm install

# Build shared package
pnpm --filter @quicksave/shared build
```

### Running the Signaling Server

The signaling server coordinates WebRTC connections between the agent and PWA.

```bash
# Start signaling server (runs on port 8080 by default)
pnpm dev:signaling

# Or specify a custom port
PORT=3001 pnpm dev:signaling
```

### Running the Agent

```bash
# Start agent pointing to local signaling server
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:agent -- --repo /path/to/repo

# Or use the -s flag
pnpm dev:agent -- --repo /path/to/repo -s ws://localhost:8080
```

### Running the PWA

```bash
# Start PWA dev server (uses production signaling by default)
pnpm dev:pwa

# Or point to local signaling server
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:pwa
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation.

## Self-Hosting

Quicksave is open source. You can:

1. Fork this repo
2. Build and deploy the PWA to any static host
3. Implement your own signaling server (protocol documented in ARCHITECTURE.md)

## License

MIT
