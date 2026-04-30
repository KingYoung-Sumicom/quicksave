# Relay WebSocket Connect-Time Authentication

**Status:** Design note. Implementation deferred until PWA push notifications (`docs/plans/2026-04-13-push-notifications.md`) ships.

**Problem owner:** `apps/relay/` + `apps/agent/` + `apps/pwa/` (all three get touched).

---

## The problem

The relay accepts WebSocket connections at `/agent/{agentId}` and `/pwa/{pubKey}` and trusts the URL-asserted identity **without any proof-of-possession check**. Peer registration in `@sumicom/ws-relay` happens immediately after URL parsing; no signature, no challenge.

Channel config in `apps/relay/src/index.ts`:

```typescript
channels: [
  { name: 'agent', onDuplicate: 'reject'  },
  { name: 'pwa',   onDuplicate: 'replace' },
]
```

Both settings let an attacker who knows the **public** identifier trivially deny service to the real peer:

| Channel | `onDuplicate` | Attack | Effect |
|---|---|---|---|
| `pwa` | `replace` | Attacker connects to `/pwa/{knownPubKey}` | ws-relay closes the real PWA with code `1000 'Replaced'`; attacker holds the slot; real PWA's reconnect also gets replaced → flapping DoS |
| `agent` | `reject` | Attacker squats `/agent/{knownAgentId}` first, then holds the connection open | Real agent's reconnect is rejected with `ID_IN_USE`; as long as the attacker reconnects faster than the real agent after any blip, the real agent is locked out |

E2E-encrypted message **content** is still safe — the attacker has no session DEK and cannot read traffic. But the attacker does not need to read anything to cause harm:

- Presence signals (`agent-status`, `pwa-bye`) are fabricated by the relay based on URL identity, so attackers can toggle "online/offline" badges, trick watchers into giving up, or mask a real user going offline.
- Any relay-level fan-out (e.g. the old `notify-push` path, before we moved it to signed HTTP) was directly spoofable.
- The attacker can also junk-fill bytes toward watchers; they drop on MAC failure, but it still consumes bandwidth.

## Why public identifiers are effectively known

- `agentId` and `pubKey` are emitted in pairing flows (QR code, add-machine modal, shared setup text). They are designed to be shared.
- They appear in the WebSocket URL path, visible to any TLS-terminating proxy (Cloudflare, nginx), access logs, browser devtools, screenshots.
- There is no rotation path short of re-pairing every existing device, which users will not do.

Treat them as **identifiers, not secrets**.

## Why push notifications are NOT affected

The push plan moved its trust root from "URL identity" to "Ed25519 signature per request" on HTTP routes. Every `/push/*` request carries a fresh signature; the attacker needs the private key, which has never left the agent. WebSocket URL-trust is orthogonal to push.

The push plan also happens to provision the agent's Ed25519 signing keypair (`identity.ts` Task 2), which this work can reuse directly — no new agent-side key material needed.

---

## Design direction

**Goal:** add proof-of-possession at WebSocket connect time, rejecting impostor connections *before* `registry.add()` runs, so the `onDuplicate` decision never has to fire against a fake peer.

**Constraint (critical):** the browser `WebSocket` API does **not** allow custom request headers. Any PWA-side auth has to ride in the URL path / query or in `Sec-WebSocket-Protocol`. Agent-side (Node.js) has no such constraint.

### Choice of "challenge" semantics

Two candidate shapes:

| Shape | Extra RTT | Replay protection | Server state grows on... |
|---|---|---|---|
| **A.** Server generates nonce, client signs, server verifies | +1 RTT after Upgrade | Implicit (nonce single-use) | **Every connection attempt** — pending entry created before auth completes |
| **B.** Client generates `{ts, nonce}`, signs, sends in Upgrade request URL | **0 extra RTT** | Needs `ts` window (±60s) + seen-nonce cache | **Successful verification only** — entry added after signature passes |

**Recommended: B.** Rationale:

- **DoS asymmetry (load-bearing reason).** A's pending-challenge map is populated *before* authentication, so any attacker can flood TCP+TLS connects with zero cryptographic cost and watch the map grow until memory is exhausted. Per-IP rate limits help against single-source floods but not distributed ones; bounded maps with LRU just shift the DoS to "evict legitimate pending entries". The only fixes that actually work ("stateless challenge" — server HMACs `client_ip|ts` into the nonce) reduce to B anyway, with a worse key-management story. B only grows seen-state on successful signatures, which means attackers without the private key cannot grow it at all.
- Zero extra RTT. Reconnect-heavy workload (mobile networks, laptops waking) benefits.
- Matches the pattern we're already using for push HTTP routes, so the codebase has one auth mental model instead of two.

B's remaining DoS surface is pure CPU (Ed25519 verify ≈ 0.1ms per attempt against bad signatures). That is handled by the existing per-IP WebSocket upgrade rate limiter in `@sumicom/ws-relay`; it's operational config, not protocol design.

**The load-bearing invariant**: `nonce cache TTL ≥ ts window`. This has to hold by construction — the two gates together close replay (within window: caught by nonce; outside window: caught by ts). Document this as a code comment next to both constants; changing one without the other silently breaks replay protection.

### Wire format

```
wss://relay/agent/{signPubKeyB64url}?ts={unixMs}&nonce={b64url}&sig={ed25519SigB64url}
wss://relay/pwa/{signPubKeyB64url}?ts={unixMs}&nonce={b64url}&sig={ed25519SigB64url}
```

Canonical signed body (UTF-8 bytes, `|` separator):

```
${channel}|${signPubKeyB64url}|${ts}|${nonce}
```

The channel is included to prevent a signature captured on one channel from being replayed on the other.

### Relay-side check (before `registry.add`)

```typescript
// INVARIANT: NONCE_TTL_MS >= TS_WINDOW_MS. Both gates together close replay;
// shortening the nonce TTL below the ts window silently reopens it.
const TS_WINDOW_MS = 60_000;
const NONCE_TTL_MS = 120_000;

function authenticatePeer(parsed: { channel, id }, url: URL, now: number): AuthResult {
  const ts = Number(url.searchParams.get('ts'));
  const nonce = url.searchParams.get('nonce');
  const sig = url.searchParams.get('sig');

  if (!Number.isFinite(ts) || !nonce || !sig)     return fail('missing auth params');
  if (Math.abs(now - ts) > TS_WINDOW_MS)          return fail('stale');
  if (seenNonces.has(nonce))                       return fail('replay');

  const canonical = `${parsed.channel}|${parsed.id}|${ts}|${nonce}`;
  const pub = b64urlToBytes(parsed.id);
  const sigBytes = b64urlToBytes(sig);
  if (!nacl.sign.detached.verify(utf8(canonical), sigBytes, pub)) return fail('bad signature');

  // Only NOW do we commit to state. seen-set can only be grown by signatures
  // that already verified — an attacker without the private key cannot.
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return ok();
}
```

The `parsed.id` IS the pubkey (URL-safe base64 Ed25519 public key), so there's no lookup step — identity and verification key are the same.

Hook point: the cleanest place is a `beforeRegister` step in `@sumicom/ws-relay`. If the library does not expose one, do the check in `onPeerConnect` and immediately `ws.close(1008, 'auth')` on failure, then `registry.remove(peer)`. Opening an issue / PR upstream to add `beforeRegister` is preferred; otherwise we need to tolerate a 1-frame window where the fake peer is registered before kicked out.

### Key material

| Principal | Keypair | Storage | Notes |
|---|---|---|---|
| Agent | Ed25519 signing | `~/.quicksave/agent.json` — **already added by push plan Task 2** | Reuse as-is |
| PWA | Ed25519 signing (NEW for this work) | IndexedDB, per paired machine | Generate lazily on first pairing; include pubkey in pairing payload sent to agent |
| Relay | No private key needed | — | Relay only verifies |

PWAs paired before this work will lack a signing keypair entirely. Same migration story as the push plan: surface "re-pair this machine to enable secure connection" hint; no automatic migration.

### Identity transition

Today: URL carries `agentId` (random string) and PWA `pubKey` (X25519 box pubkey).

After this work: URL carries the Ed25519 signing pubkey for both channels. The existing X25519 box keypair continues its E2E-encryption role unchanged. The `agentId` as a distinct random string can be retired (or kept purely as a display slug, e.g. truncated signing pubkey).

This is a **breaking change** to the relay URL schema and all pairing artefacts. It must be rolled out with a version bump and a re-pair flow; there is no backwards-compat path that is also secure.

---

## Open questions

1. **Library pre-register hook.** Resolved: `@sumicom/ws-relay@0.1.1` has no such hook; we will add `RelayHooks.verifyPeer` to the library in version `0.2.0`. Spec: `docs/plans/2026-04-18-ws-relay-library-changes.md`. The library work can be delegated to another agent in parallel with PWA push — both must ship before this plan can start implementation.

2. **Clock skew tolerance** — ±60s is a reasonable default, but agents running on laptops that sleep for days can wake with very stale clocks. **This is the main practical failure mode of approach B** — clients get bounced with `1008 stale` not because of an attack but because their clock is wrong. Required fallback: on receiving `1008 stale`, client parses the `server-time` hint returned by the relay (the relay should include its `now` in the close reason or as a header/frame immediately before close), adjusts its timestamp offset for this connection, and retries once. Without this, laptops waking from sleep will have a broken reconnect loop.

3. **Relay CPU rate limiting** — the remaining DoS surface for approach B is bad-signature flood (each triggers an Ed25519 verify). Confirm `@sumicom/ws-relay`'s per-IP upgrade rate limiter is enabled with a sane threshold, and consider adding a separate budget for "verification failures" vs. "successful connects" so an attacker can't burn through the signup budget to deny legitimate reconnects.

4. **Multi-device PWA** — if one user has two PWA instances, each has its own signing keypair, so each has its own `signPubKey`. Nothing in this design forces "one identity per user"; that's kept at the pairing-list layer inside the agent.

5. **Relay stats / observability** — add `authFailures` counter to `/stats` (broken down by reason: stale / replay / bad-sig / missing-params) so we can see whether this is actually being probed in production once deployed. Sustained high `replay` counts would be the signal to reconsider server-issued challenge; we expect it to stay ~zero.

6. **Does the fix also deprecate `watch-agent`'s open-subscription behaviour?** Today any PWA can `watch-agent { any agentId }` without authorisation. After connect auth, the PWA is cryptographically identified — so we could add a "PWA X is allowed to watch agent Y" check (driven by agent-signed capability, similar to push). Out of scope for this doc but worth revisiting when we come back to implement.

---

## Follow-ups / related

- **Push notifications plan** (`docs/plans/2026-04-13-push-notifications.md`) — ships first. Provisions the agent signing keypair this work reuses.
- **`@sumicom/ws-relay` library changes** (`docs/plans/2026-04-18-ws-relay-library-changes.md`) — adds the `verifyPeer` hook this plan depends on. Can run in parallel with the push plan; another agent can own the library PR.
- **Relay version bump & PWA re-pair UX** — needed as a coordinated release when this lands.
