# `@sumicom/ws-relay` — Library Changes Required for Connect-Time Auth

**Status:** Spec. To be implemented in the `@sumicom/ws-relay` repository (separate from quicksave). Blocks `docs/plans/2026-04-18-relay-connect-auth.md`; scheduled to start after PWA push notifications (`docs/superpowers/plans/2026-04-13-push-notifications.md`) ships.

**Intended reader:** a contributor working directly in the ws-relay repo. This document is self-contained and does not require access to the quicksave codebase.

**Current version:** `0.1.1`. All line numbers reference `dist/relay.js` of that version.

---

## Why

Consumers of this library (specifically the quicksave signaling relay) need to cryptographically authenticate connecting peers *before* they are entered into the `PeerRegistry`. Today the library has only a post-registration hook (`onPeerConnect`), which means:

- With `onDuplicate: 'replace'`, a new connection evicts the existing peer **before** any consumer auth check can run. An attacker who knows only the public identifier (URL path) can flap a legitimate peer offline indefinitely.
- With `onDuplicate: 'reject'`, an attacker can squat the slot by connecting first, then hold it open; the real peer's reconnect is rejected with `ID_IN_USE`.

Consumer-side workarounds (checking in `onPeerConnect` and then calling `registry.remove`) leave a one-frame window during which watchers are notified the attacker is "online". That window is closable only from inside the library.

The full threat analysis is owned by the consumer project and is not needed to implement these changes. What matters for the library: we need a **pre-registration hook** that can veto a connection with the full HTTP request in hand.

---

## Changes required

### Change 1 — Add `verifyPeer` hook [REQUIRED, blocks consumer]

Add a new optional field to `RelayHooks` in `src/types.ts`:

```typescript
export interface RelayHooks {
  // ... existing hooks ...

  /**
   * Called after URL parsing but BEFORE duplicate resolution and registry insertion.
   * Lets consumers cryptographically verify that the connecting peer is who the URL
   * claims it to be (e.g. by validating a signature in query params against the
   * URL-asserted public key).
   *
   * Return `{ ok: true }` to allow the connection to proceed to duplicate handling
   * and registry insertion.
   *
   * Return `{ ok: false, ... }` to refuse. The library will send an error frame and
   * close the WebSocket with the given code/reason. The peer is NEVER added to the
   * registry; no watchers are notified; onDuplicate logic does NOT run (so a replay
   * cannot evict a legitimate peer).
   *
   * May be async. If it throws or rejects, the connection is closed with code 1011
   * ('Internal verification error') and the error is logged to console.error.
   */
  verifyPeer?(ctx: {
    parsed: { channel: string; id: string };
    req: IncomingMessage;
    ip: string;
  }): Promise<VerifyPeerResult> | VerifyPeerResult;
}

export type VerifyPeerResult =
  | { ok: true }
  | { ok: false; reason?: string; closeCode?: number; errorCode?: string };
```

Default behavior when `verifyPeer` is not provided: **unchanged from today** (connection proceeds to duplicate check). This keeps the change backwards-compatible.

**Placement in `wss.on('connection')` handler** (`dist/relay.js:180`):

```
  1. Get client IP                                    (unchanged)
  2. Rate limit                                       (unchanged)
  3. Key validation (keyStore)                        (unchanged)
  4. parsePeerUrl                                     (unchanged)
  5. --- NEW: call hooks.verifyPeer({parsed, req, ip}) ---
       on failure:
         sendMessage(extWs, { type: 'error', payload: {
           code: result.errorCode ?? 'VERIFY_FAILED',
           message: result.reason ?? 'Peer verification failed'
         }});
         ws.close(result.closeCode ?? 1008, result.reason ?? 'Verify failed');
         return;   // do NOT proceed to step 6
  6. Duplicate check + onDuplicate resolution         (unchanged)
  7. Create peer, register, notify watchers, fire onPeerConnect  (unchanged)
```

**Critical ordering constraint:** `verifyPeer` must run BEFORE the duplicate check in step 6. This is the whole point — a failed verification must not be able to trigger `onDuplicate: 'replace'` and evict a legitimate peer.

**Why not use `verifyClient` (pre-Upgrade hook)?** `ws`'s `verifyClient` runs before the HTTP Upgrade completes, which means we can't send structured error frames back — only HTTP error codes. Consumers benefit from structured `{type: 'error', payload: {code, message}}` messages for client-side handling, and the latency cost of doing auth post-Upgrade is negligible. Prefer post-Upgrade, pre-registry.

### Change 2 — Export `VerifyPeerResult` type [REQUIRED]

Add to `src/index.ts`:

```typescript
export type { VerifyPeerResult } from './types.js';
```

Already listed alongside the other type exports that are re-exported from the package root.

### Change 3 — Version bump [REQUIRED]

This is a **backwards-compatible additive change** to the `RelayHooks` interface (new optional field). Semver: **minor bump**.

- `0.1.1` → `0.2.0`
- Update `package.json` version.
- Update `CHANGELOG.md` (create if missing) with an entry under `## [0.2.0]`:
  - `Added: RelayHooks.verifyPeer async hook for pre-registration peer verification. Runs after URL parsing, before duplicate resolution and registry insertion. Lets consumers veto connections based on the full HTTP request (e.g. signed query params). Existing consumers are unaffected — when the hook is not provided, behavior is identical to 0.1.1.`

---

## Changes suggested (nice-to-have, not blocking)

### Change 4 — Stale-peer auto-eviction option [OPTIONAL]

Current `onDuplicate: 'reject'` semantics allow a squatter to hold a dead connection open and block legitimate reconnects (TCP half-open, NAT timeout, etc.). Add an opt-in flag to `ChannelConfig`:

```typescript
export interface ChannelConfig {
  // ... existing ...

  /**
   * If set, an existing peer whose connection has had no activity for
   * longer than this many milliseconds is considered stale and will be
   * evicted when a new connection arrives with the same id, regardless
   * of `onDuplicate`. Default: undefined (no stale eviction).
   */
  staleEvictMs?: number;
}
```

Activity = time of last pong heartbeat or last message received, whichever is more recent. Library already tracks this implicitly via the heartbeat loop; wire it up.

This is a defense-in-depth measure; `verifyPeer` already solves the main attack vector, but stale eviction helps real operational edge cases (client crashed without FIN, cell network lost, etc.).

### Change 5 — Verification failure counters in `getStats()` [OPTIONAL]

Extend `RegistryStats` with a counter of verification rejections, broken down by reason (if consumer provides one):

```typescript
verifyFailures: {
  total: number;
  byReason: Record<string, number>;  // reason string → count
};
```

Increment inside the library right before the `ws.close()` in step 5 above. Exposes operational signal for consumers monitoring auth-probe attempts.

---

## Test coverage required

Add to `test/relay.test.ts` (or create a dedicated `test/verifyPeer.test.ts`):

1. **Happy path** — `verifyPeer` returns `{ok: true}` → connection registered normally, `onPeerConnect` fires.
2. **Sync reject** — `verifyPeer` returns `{ok: false, reason, closeCode}` synchronously → ws closed with given code, error frame sent, peer never in registry, `onPeerConnect` does NOT fire.
3. **Async reject** — same as (2) but returning a Promise.
4. **Thrown error** — `verifyPeer` throws → ws closed with code 1011, error logged, peer never registered.
5. **Rejection does not trigger replace** — set `onDuplicate: 'replace'`, have an existing peer registered with id X, open a new connection to the same id X whose `verifyPeer` returns `{ok: false}` → **existing peer must remain connected and in registry**. This is the critical invariant.
6. **Rejection does not trigger reject-of-legit** — set `onDuplicate: 'reject'`, have an existing peer, open a new connection whose `verifyPeer` rejects → existing peer still present, new connection closed with verify reason (not `ID_IN_USE`).
7. **Absent hook = unchanged behavior** — full compat test with 0.1.1 semantics.
8. **Stale eviction** (only if Change 4 implemented) — existing peer with no heartbeat for `staleEvictMs + 100`ms; new legitimate connect evicts the stale peer regardless of `onDuplicate: 'reject'`.

Use the existing test harness style; `vitest` is already the project's runner.

---

## Migration notes for the quicksave consumer

(Informational — these happen in the consumer repo, not in ws-relay.)

After `@sumicom/ws-relay@0.2.0` is published:

1. Consumer bumps the dependency.
2. Consumer implements its `verifyPeer` hook (Ed25519 signature check over URL query params `?ts=&nonce=&sig=` against the path-asserted public key; full design in `docs/plans/2026-04-18-relay-connect-auth.md`).
3. Consumer adds a URL-param signing step to both its agent-side and PWA-side WebSocket clients.
4. Coordinated release + forced re-pair for existing paired devices (URL schema changes from `agentId` to `signPubKey`).

The library work is independent of steps 2–4 and can ship first.

---

## Out of scope for this library change

- **Signature verification itself** — the library should have no opinion on what kind of "verification" the consumer does. It just provides the hook. Do not import cryptographic libraries into ws-relay for this work.
- **Nonce replay cache** — same. The consumer owns the replay window + seen-nonce cache; the library only invokes the hook.
- **URL schema changes** — the library already supports arbitrary `parseId` customization. No changes needed to URL parsing for this work.
- **Relay-wide rate limiting tuning** — the existing `rateLimitMaxConnections` is sufficient for now. Revisit if consumers report auth-probe CPU issues after deployment.

---

## Deliverable checklist

- [ ] Implement `RelayHooks.verifyPeer` per Change 1 specification
- [ ] Export `VerifyPeerResult` type (Change 2)
- [ ] Tests 1–7 above passing
- [ ] Tests 8 passing (if Change 4 included)
- [ ] Version bump to `0.2.0` (Change 3)
- [ ] `CHANGELOG.md` entry
- [ ] README snippet showing a minimal `verifyPeer` example
- [ ] `npm publish` (after review)

Once published, file an issue on the quicksave repo referencing this PR so the consumer-side work (`relay-connect-auth.md`) can proceed.
