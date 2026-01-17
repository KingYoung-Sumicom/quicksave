# Quicksave - Remote Git Control PWA

## Overview

Quicksave is a Progressive Web App (PWA) that enables vibe coders to remotely control a computer's git working tree. It focuses on reviewing, staging, and committing changes through a secure WebRTC connection with end-to-end encryption.

## Core Principles

1. **Privacy First**: All data transmitted between devices is end-to-end encrypted
2. **Minimal Server Footprint**: Server only handles signaling; all git operations go through WebRTC data channels
3. **Offline Capable**: PWA works offline with cached UI; reconnects when network is available
4. **Mobile Friendly**: Designed for reviewing and committing code on mobile devices

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              QUICKSAVE ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   PWA Client    │◄───────►│ Signaling Server│◄───────►│  Desktop Agent  │
│   (Browser)     │   WS    │   (Minimal)     │   WS    │  (Local Machine)│
└────────┬────────┘         └─────────────────┘         └────────┬────────┘
         │                                                        │
         │              WebRTC Data Channel (E2E Encrypted)       │
         └────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Git Commands  │
                    │   (Local Repo)  │
                    └─────────────────┘
```

### Components

#### 1. PWA Client (Browser)
- React + TypeScript frontend
- Tailwind CSS for styling
- Service Worker for offline support
- WebRTC for peer-to-peer communication
- TweetNaCl.js for E2E encryption

#### 2. Signaling Server (Minimal)
- Node.js + WebSocket server
- Only handles connection establishment
- No data persistence required
- Stateless design for easy scaling
- **Public server available** at `wss://signal.quicksave.dev` (default)
- Can be self-hosted for enterprise/privacy needs

#### 3. Desktop Agent
- Node.js CLI application
- Runs on the machine with git repositories
- Executes git commands locally
- Streams results back via WebRTC

## Technology Stack

### Frontend (PWA)
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Framework | React 18 | Widely adopted, excellent PWA support |
| Language | TypeScript | Type safety for complex state |
| Styling | Tailwind CSS | Rapid development, small bundle |
| Build Tool | Vite | Fast HMR, optimized builds |
| State | Zustand | Lightweight, no boilerplate |
| WebRTC | Native API | No abstraction needed for data channels |
| Encryption | TweetNaCl.js | Audited, minimal, fast |

### Backend (Signaling Server)
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js | JavaScript consistency |
| WebSocket | ws | Minimal, performant |
| Deployment | Docker | Easy self-hosting |

### Desktop Agent
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js | JavaScript consistency |
| Git | simple-git | Well-maintained git wrapper |
| IPC | WebRTC | Same as PWA for consistency |

## Open Source Strategy

### Repository Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                     OPEN SOURCE vs CLOSED SOURCE                 │
└─────────────────────────────────────────────────────────────────┘

   OPEN SOURCE (MIT)                    CLOSED SOURCE
   ─────────────────                    ─────────────────
   ┌─────────────────┐                  ┌─────────────────┐
   │   PWA Client    │                  │ Signaling Server│
   │   (React)       │                  │ Implementation  │
   └─────────────────┘                  └─────────────────┘
   ┌─────────────────┐                  ┌─────────────────┐
   │  Desktop Agent  │                  │  License API    │
   │   (Node CLI)    │                  │ (Certificate    │
   └─────────────────┘                  │  issuance)      │
   ┌─────────────────┐                  └─────────────────┘
   │ Shared Package  │
   │ (types/crypto)  │
   └─────────────────┘
   ┌─────────────────┐
   │ Signaling Proto │  ◄── Protocol spec is PUBLIC
   │ (documented)    │      Implementation is CLOSED
   └─────────────────┘
```

### What's Open Source

| Component | License | Repository |
|-----------|---------|------------|
| PWA Client | MIT | `quicksave/quicksave` |
| Desktop Agent | MIT | `quicksave/quicksave` |
| Shared Types | MIT | `quicksave/quicksave` |
| Signaling Protocol | MIT | `quicksave/quicksave` (docs only) |

### What's Closed Source

| Component | Reason |
|-----------|--------|
| Signaling Server | Operational simplicity, prevents abuse |
| License API | Payment processing, certificate signing |

## Business Model

### Pricing

| Tier | Price | What You Get |
|------|-------|--------------|
| **Free** | $0 | Full features + banner ad on hosted PWA |
| **Pro** | $15 (one-time) | No ads on hosted PWA (hosting fee) |
| **Self-Hosted** | $0 | Fork repo, host yourself, no ads, no limits |

### What Users Are Paying For

The $15 is a **hosting fee**, not a software license:

| Service | Cost to Us | Value to User |
|---------|------------|---------------|
| PWA hosting (CDN) | ~$5/mo | No setup, always updated |
| Signaling server | ~$20/mo | Reliable, low-latency relay |
| Domain & SSL | ~$15/yr | Trust, easy to remember |
| **Total** | ~$300/yr | Convenience |

At 50,000 paying users × $15 = $750K covers infrastructure indefinitely.

### Self-Hosting Option

Users who self-host get:
- ✓ Full functionality
- ✓ No ads (it's their PWA)
- ✓ No payment required
- ✓ Run their own signaling server
- ✗ No official support

```bash
# Self-host the PWA
git clone https://github.com/quicksave/quicksave
cd quicksave
pnpm install && pnpm build
# Deploy apps/pwa/dist to any static host

# Run your own signaling server (protocol is documented)
# Implement based on SIGNALING_PROTOCOL.md
```

### Privacy-Preserving License Verification

For users of the hosted PWA who pay for ad removal:

```
┌─────────────────────────────────────────────────────────────────┐
│                    LICENSE VERIFICATION FLOW                     │
└─────────────────────────────────────────────────────────────────┘

1. User purchases Pro ($15 one-time)
   └─► Provides their agent's public key at checkout

2. Server issues a signed certificate
   └─► Certificate contains: public key + signature

3. Certificate stored in Desktop Agent config
   └─► Agent sends certificate to PWA on connection

4. PWA verifies certificate signature (offline)
   └─► If valid, hide ads; if invalid/missing, show ads
```

### Certificate Format

```typescript
interface License {
  version: 1;
  publicKey: string;      // Agent's public key (base64)
  issuedAt: number;       // Unix timestamp
  type: 'pro';            // License type
  signature: string;      // Ed25519 signature by Quicksave
}

// Verification (in PWA - no server call needed)
function verifyLicense(license: License): boolean {
  const message = `${license.version}:${license.publicKey}:${license.issuedAt}:${license.type}`;
  return nacl.sign.detached.verify(
    decodeUTF8(message),
    decodeBase64(license.signature),
    QUICKSAVE_PUBLIC_KEY  // Hardcoded in PWA
  );
}
```

### What We Store

| Data | Stored | Purpose |
|------|--------|---------|
| Agent public key | ✓ | Certificate generation |
| Payment info | ✓ (via Stripe) | Billing |
| Email (optional) | ✓ | Receipt delivery |
| Usage data | ✗ | Not possible (E2E encrypted) |
| Git data | ✗ | Not possible (E2E encrypted) |

### Revenue Projection

| Metric | Estimate |
|--------|----------|
| Global vibe coders (mid-2026) | ~35 million |
| Use git regularly | ~10 million |
| Would want mobile git control | ~1 million |
| Prefer hosted over self-host | ~80% → 800K |
| Willing to pay $15 | 5-10% |
| **Potential paying customers** | **40,000 - 80,000** |
| **Revenue at $15** | **$600K - $1.2M** |

### Ad Strategy (Free Tier on Hosted PWA)

- Small, non-intrusive banner at bottom
- No tracking or personalized ads
- Static sponsor/affiliate banners only
- Consider: ethical ad networks (Carbon, EthicalAds)

## Signaling Protocol Specification

The signaling protocol is **publicly documented** so anyone can implement their own server.

### Overview

The signaling server is a simple WebSocket relay that:
1. Accepts connections from agents and PWAs
2. Matches them by agent ID
3. Forwards WebRTC signaling messages
4. Has no knowledge of message contents (all E2E encrypted)

### WebSocket Endpoints

```
wss://signal.quicksave.dev/agent/{agentId}   # Desktop Agent connects here
wss://signal.quicksave.dev/pwa/{agentId}     # PWA connects here
```

### Message Types

```typescript
// Agent → Server → PWA
interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'bye';
  payload: unknown;  // WebRTC SDP or ICE candidate
}

// Server → Agent (when PWA connects)
interface PeerConnectedMessage {
  type: 'peer-connected';
}

// Server → PWA (when Agent is not online)
interface PeerOfflineMessage {
  type: 'peer-offline';
}
```

### Server Behavior

```
Agent connects to /agent/{id}
  └─► Server stores WebSocket reference for {id}

PWA connects to /pwa/{id}
  ├─► If agent online: send 'peer-connected' to agent
  └─► If agent offline: send 'peer-offline' to PWA

Either side sends message
  └─► Server forwards to the other side (no inspection)

WebRTC established
  └─► Both sides can disconnect from signaling server
      (data flows directly via WebRTC)
```

### Reference Implementation

A minimal reference implementation is provided in the docs:

```typescript
// Minimal signaling server (~50 lines)
const agents = new Map<string, WebSocket>();
const pwas = new Map<string, WebSocket>();

wss.on('connection', (ws, req) => {
  const [_, role, agentId] = req.url.match(/\/(agent|pwa)\/(.+)/);

  if (role === 'agent') {
    agents.set(agentId, ws);
    ws.on('message', data => pwas.get(agentId)?.send(data));
    ws.on('close', () => agents.delete(agentId));
  } else {
    pwas.set(agentId, ws);
    const agent = agents.get(agentId);
    if (agent) {
      agent.send(JSON.stringify({ type: 'peer-connected' }));
    } else {
      ws.send(JSON.stringify({ type: 'peer-offline' }));
    }
    ws.on('message', data => agents.get(agentId)?.send(data));
    ws.on('close', () => pwas.delete(agentId));
  }
});
```

This allows anyone to self-host while we maintain a production-grade closed-source implementation with rate limiting, monitoring, and abuse prevention

## Security Model

### End-to-End Encryption

```
┌─────────────────────────────────────────────────────────────────┐
│                    KEY EXCHANGE FLOW                            │
└─────────────────────────────────────────────────────────────────┘

1. Desktop Agent generates keypair on first run
   └─► Public key displayed as QR code / connection code

2. PWA scans QR code or enters connection code
   └─► Extracts agent's public key

3. PWA generates ephemeral keypair for session
   └─► Sends public key via signaling server

4. Both parties derive shared secret using X25519
   └─► All subsequent messages encrypted with XSalsa20-Poly1305
```

### Encryption Details

- **Key Exchange**: X25519 (Curve25519 ECDH)
- **Symmetric Encryption**: XSalsa20-Poly1305 (authenticated encryption)
- **Nonce**: 24-byte random nonce per message
- **Library**: TweetNaCl.js (audited, no dependencies)

### Trust Model

1. User physically controls the desktop agent
2. Connection code/QR contains the agent's public key
3. Only devices with the correct public key can decrypt messages
4. Signaling server sees only encrypted key exchange data
5. All git operation data flows through encrypted WebRTC channel

## Protocol Specification

### Message Format

All messages are JSON objects encrypted with the shared secret:

```typescript
interface Message {
  id: string;          // UUID for request/response correlation
  type: MessageType;   // Type of message
  payload: unknown;    // Type-specific payload
  timestamp: number;   // Unix timestamp
}

type MessageType =
  | 'ping'
  | 'pong'
  | 'git:status'
  | 'git:status:response'
  | 'git:diff'
  | 'git:diff:response'
  | 'git:stage'
  | 'git:stage:response'
  | 'git:unstage'
  | 'git:unstage:response'
  | 'git:commit'
  | 'git:commit:response'
  | 'git:log'
  | 'git:log:response'
  | 'git:branches'
  | 'git:branches:response'
  | 'git:checkout'
  | 'git:checkout:response'
  | 'git:discard'
  | 'git:discard:response'
  | 'error';
```

### Git Operations

#### Status
```typescript
// Request
{ type: 'git:status', payload: { path?: string } }

// Response
{
  type: 'git:status:response',
  payload: {
    branch: string;
    ahead: number;
    behind: number;
    staged: FileChange[];
    unstaged: FileChange[];
    untracked: string[];
  }
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;  // For renamed files
}
```

#### Diff
```typescript
// Request
{
  type: 'git:diff',
  payload: {
    path: string;
    staged?: boolean;
  }
}

// Response
{
  type: 'git:diff:response',
  payload: {
    path: string;
    hunks: DiffHunk[];
  }
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}
```

#### Stage/Unstage
```typescript
// Request
{
  type: 'git:stage',
  payload: { paths: string[] }
}

// Response
{
  type: 'git:stage:response',
  payload: { success: boolean; error?: string }
}
```

#### Commit
```typescript
// Request
{
  type: 'git:commit',
  payload: {
    message: string;
    description?: string;
  }
}

// Response
{
  type: 'git:commit:response',
  payload: {
    success: boolean;
    hash?: string;
    error?: string;
  }
}
```

#### Log
```typescript
// Request
{
  type: 'git:log',
  payload: { limit?: number }
}

// Response
{
  type: 'git:log:response',
  payload: {
    commits: Commit[];
  }
}

interface Commit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}
```

## WebRTC Connection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONNECTION ESTABLISHMENT                      │
└─────────────────────────────────────────────────────────────────┘

Desktop Agent                Signaling Server                 PWA
     │                             │                           │
     │──── Connect (agentId) ─────►│                           │
     │                             │                           │
     │                             │◄──── Connect (agentId) ───│
     │                             │                           │
     │◄─── PWA wants to connect ───│                           │
     │                             │                           │
     │──── Create Offer ──────────►│──── Forward Offer ───────►│
     │                             │                           │
     │◄─── Forward Answer ─────────│◄──── Create Answer ───────│
     │                             │                           │
     │◄─────────── ICE Candidates Exchange ───────────────────►│
     │                             │                           │
     │◄═══════════ WebRTC Data Channel Established ═══════════►│
     │                             │                           │
     │         (Signaling server no longer needed)             │
     │                             │                           │
     │◄════════ E2E Encrypted Git Operations ═════════════════►│
```

## Project Structure

```
quicksave/
├── apps/
│   ├── pwa/                    # React PWA
│   │   ├── public/
│   │   │   ├── manifest.json
│   │   │   └── sw.js
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── ConnectionSetup.tsx
│   │   │   │   ├── FileList.tsx
│   │   │   │   ├── DiffViewer.tsx
│   │   │   │   ├── CommitForm.tsx
│   │   │   │   └── StatusBar.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useWebRTC.ts
│   │   │   │   ├── useEncryption.ts
│   │   │   │   └── useGitOperations.ts
│   │   │   ├── stores/
│   │   │   │   ├── connectionStore.ts
│   │   │   │   └── gitStore.ts
│   │   │   ├── lib/
│   │   │   │   ├── crypto.ts
│   │   │   │   ├── webrtc.ts
│   │   │   │   └── protocol.ts
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── agent/                  # Desktop Agent
│   │   ├── src/
│   │   │   ├── git/
│   │   │   │   ├── operations.ts
│   │   │   │   └── watcher.ts
│   │   │   ├── webrtc/
│   │   │   │   ├── connection.ts
│   │   │   │   └── signaling.ts
│   │   │   ├── crypto/
│   │   │   │   └── encryption.ts
│   │   │   ├── handlers/
│   │   │   │   └── messageHandler.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── signaling/              # Signaling Server
│       ├── src/
│       │   └── index.ts
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   └── shared/                 # Shared types and utilities
│       ├── src/
│       │   ├── types.ts
│       │   ├── protocol.ts
│       │   └── crypto.ts
│       ├── package.json
│       └── tsconfig.json
│
├── package.json                # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── ARCHITECTURE.md
└── README.md
```

## User Interface

### Screens

#### 1. Connection Screen
- Display QR code / connection code from agent
- Manual code entry option
- Connection status indicator

#### 2. Repository Overview
- Current branch name
- Ahead/behind indicator
- List of changed files (staged/unstaged/untracked)
- Pull/push indicators

#### 3. File Diff View
- Unified or split diff view
- Syntax highlighting
- Stage/unstage individual hunks (future)

#### 4. Commit Screen
- Commit message input
- Optional description
- List of staged files
- Commit button

### Mobile-First Design

```
┌─────────────────────────┐
│  ≡  quicksave    ●──    │  ← Header with connection status
├─────────────────────────┤
│  main ↑2 ↓1             │  ← Branch info
├─────────────────────────┤
│  ┌─────────────────────┐│
│  │ Staged (2)        ▼ ││
│  │  ✓ src/App.tsx      ││
│  │  ✓ src/utils.ts     ││
│  └─────────────────────┘│
│  ┌─────────────────────┐│
│  │ Changed (3)       ▼ ││
│  │  ○ src/index.ts     ││
│  │  ○ README.md        ││
│  │  ○ package.json     ││
│  └─────────────────────┘│
│  ┌─────────────────────┐│
│  │ Untracked (1)     ▼ ││
│  │  + .env.local       ││
│  └─────────────────────┘│
├─────────────────────────┤
│  [    Commit (2)    ]   │  ← Sticky commit button
└─────────────────────────┘
```

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| MITM on signaling | E2E encryption with pre-shared public key |
| Signaling server compromise | Server only sees encrypted data |
| Replay attacks | Timestamps and nonces in messages |
| Unauthorized access | Connection requires physical access to agent |
| Data exfiltration | All sensitive data stays in WebRTC channel |

### Security Best Practices

1. **Never log sensitive data** - No commit messages, file contents, or diffs in logs
2. **Rotate session keys** - New ephemeral keypair per connection
3. **Validate all inputs** - Sanitize file paths to prevent directory traversal
4. **Rate limiting** - Prevent brute force on connection codes
5. **Connection timeout** - Auto-disconnect after inactivity

## Performance Considerations

### Optimizations

1. **Chunked transfers** - Large diffs sent in chunks via data channel
2. **Diff caching** - Cache diffs on agent, invalidate on file change
3. **Lazy loading** - Only fetch diff when file is expanded
4. **Compression** - Gzip compress large payloads before encryption
5. **Connection persistence** - Maintain WebRTC connection across app suspends

### Limits

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Max diff size | 1MB | Prevent memory issues on mobile |
| Max files in status | 1000 | UI performance |
| Commit history | 50 | Initial load, paginate for more |
| Connection timeout | 30min | Battery/resource conservation |

## Deployment

### PWA Hosting
- Static hosting (Vercel, Netlify, GitHub Pages)
- HTTPS required for Service Worker and WebRTC

### Signaling Server

#### Option 1: Public Signaling Server (Default)
- Hosted at `wss://signal.quicksave.dev` (or similar)
- Free tier with rate limiting
- No signup required
- Privacy: Only encrypted WebRTC signaling data passes through

#### Option 2: Self-Hosted
- Docker container for self-hosting
- Deploy to fly.io, Railway, Render, or your own infrastructure
- Full control over availability and logs
- Recommended for enterprise/sensitive projects

```bash
# Self-hosted deployment
docker run -p 8080:8080 quicksave/signaling-server

# Or deploy to fly.io
fly launch --image quicksave/signaling-server
```

#### Signaling Server Selection
The agent and PWA both accept a `--signaling` flag to specify the server:

```bash
# Use public server (default)
quicksave-agent --repo /path/to/repo

# Use self-hosted server
quicksave-agent --repo /path/to/repo --signaling wss://my-server.com
```

### Desktop Agent
- npm package with global install
- Optional: Standalone binary via pkg

## Future Enhancements

1. **Hunk-level staging** - Stage individual hunks from diff view
2. **Multiple repositories** - Switch between repos on same agent
3. **Collaborative review** - Multiple PWA clients connected to same agent
4. **Conflict resolution** - Visual merge conflict editor
5. **Stash support** - Create and apply stashes
6. **Push/Pull** - Remote operations with credential forwarding

## Development Phases

### Phase 1: Core Infrastructure
- [ ] Project setup with pnpm workspaces
- [ ] Shared types and protocol definitions
- [ ] Basic encryption utilities
- [ ] WebRTC connection establishment
- [ ] Signaling server

### Phase 2: Desktop Agent
- [ ] Git operations wrapper
- [ ] Message handler for all git commands
- [ ] Connection code generation
- [ ] CLI interface

### Phase 3: PWA Client
- [ ] React app setup with Vite
- [ ] Connection UI
- [ ] Repository status view
- [ ] Diff viewer
- [ ] Commit flow

### Phase 4: Polish
- [ ] PWA manifest and service worker
- [ ] Offline support
- [ ] Error handling and retry logic
- [ ] Mobile optimizations
- [ ] Testing

---

## Quick Start (for developers)

```bash
# Install dependencies
pnpm install

# Start signaling server
pnpm --filter signaling dev

# Start desktop agent
pnpm --filter agent dev -- --repo /path/to/repo

# Start PWA development
pnpm --filter pwa dev
```

## License

MIT
