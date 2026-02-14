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
npm install -g @sumicom/quicksave

# Run in your git repository
cd /path/to/your/repo
quicksave
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
pnpm --filter @sumicom/quicksave-shared build

# Start dev server (PWA + signaling on same port)
pnpm dev
```

This runs Vite with an embedded signaling server on port 5173. Access the PWA at `http://localhost:5173/` with full HMR support.

### Running Components Separately

#### Signaling Server (standalone)

For production or testing the standalone signaling server:

```bash
# Start signaling server only (port 8080)
pnpm dev:signaling

# Custom port
PORT=3001 pnpm dev:signaling
```

#### Agent

```bash
# Start agent pointing to local signaling server
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:agent -- --repo /path/to/repo

# Or use the -s flag
pnpm dev:agent -- --repo /path/to/repo -s ws://localhost:8080
```

#### PWA

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
