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

This runs Vite with an embedded relay server on port 5173. Access the PWA at `http://localhost:5173/` with full HMR support.

### Running Components Separately

#### Relay Server (standalone)

For production or testing the standalone relay server:

```bash
# Start relay server only (port 8080)
pnpm dev:relay

# Custom port
PORT=3001 pnpm dev:relay
```

#### Agent

```bash
# Start agent pointing to local relay server
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:agent -- --repo /path/to/repo

# Or use the -s flag
pnpm dev:agent -- --repo /path/to/repo -s ws://localhost:8080
```

#### PWA

```bash
# Start PWA dev server (uses production signaling by default)
pnpm dev:pwa

# Or point to local relay server
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:pwa
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation.

## Self-Hosting

Quicksave is fully self-hostable. You need two things: a relay server and a PWA build pointed at it.

### 1. Deploy the Relay Server

The relay server is a stateless Node.js process. Run it with Docker:

```bash
docker build -f apps/relay/Dockerfile -t quicksave-relay .
docker run -p 8080:8080 quicksave-relay
```

Put it behind a reverse proxy (nginx, Caddy, Cloudflare) that terminates TLS — the relay itself only speaks plain HTTP/WebSocket.

### 2. Build and Deploy the PWA

Point the PWA at your relay server at build time:

```bash
QUICKSAVE_SIGNALING_URL=wss://your-relay.example.com pnpm build:pwa
```

Then deploy `apps/pwa/dist/` to any static host (Cloudflare Pages, Netlify, S3, etc.).

## License

MIT
