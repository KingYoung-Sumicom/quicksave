# Future Enhancements

A backlog of "good to have" features — designs we've thought through but
have not committed to building. Each entry should capture enough context
that a future implementer can pick it up without re-deriving the design.

---

## Master Secret Hardening (non-extractable CryptoKey + WebAuthn PRF)

**Status**: Planned, two-phase rollout. Implementation deferred.

**Today (`apps/pwa/src/lib/secureStorage.ts`)**: master secret is 32 random
bytes stored in IndexedDB (`quicksave-secure`) as a **base64 string**. An
attacker who can read the IDB database file off disk gets the bytes
directly — no key derivation, no wrapping. On installed PWA / desktop
this is rare but not impossible (full-disk access on a stolen device,
forensic dump, malicious extension with `unlimitedStorage` permission).

This entry covers two layered improvements: a cheap software-only fix
that all browsers benefit from, and an opt-in hardware-backed upgrade
for modern devices.

### Phase A — Non-extractable CryptoKey (universal, no UX change)

Replace the raw base64 string with a Web Crypto `CryptoKey` generated
with `extractable: false`. Store the **`CryptoKey` object itself** in
IDB (structured clone serialises a key handle reference, not the bytes).

```ts
const key = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 },
  /* extractable */ false,
  ['encrypt', 'decrypt'],
);
await store.put(key, 'master-key');
```

**What changes for an attacker:**

| Threat | Before (base64) | After (non-extractable) |
| --- | --- | --- |
| Dump IDB file off disk | ✅ key bytes recovered | ❌ opaque handle, no usable bytes |
| `crypto.subtle.exportKey()` from JS | ✅ returns bytes | ❌ throws `InvalidAccessError` |
| `wrapKey()` to leak the key | ✅ works | ❌ blocked by extractable flag |
| Same-origin XSS calling `encrypt`/`decrypt` | ✅ works | ✅ still works (use of key not blocked) |
| Browser process memory dump (debugger / root) | ✅ key in heap | ✅ still in process heap |

**This is software enforcement, not hardware.** The protection is "the
export gate refuses to give you the bytes" — useful against disk-dump
attackers, useless against an attacker who can attach a debugger to
the browser process. For commodity AES-GCM keys, the material lives in
the browser process heap (not OS keystore) on every major platform.

**Migration path**: detect legacy raw-bytes record on startup, wrap it
into a non-extractable CryptoKey, write back, delete legacy record. One
boot cycle and old installs are migrated silently.

**Touches**: `secureStorage.ts` only. All call sites that consume the
secret (session DEK derivation in `packages/shared/src/crypto.ts`)
continue to work because we expose the same encrypt/decrypt API —
they never needed the raw bytes anyway.

### Phase B — WebAuthn PRF wrapping (hardware-backed, opt-in)

Layered on top of Phase A. Adds Keychain / Secure Enclave / TPM
protection of the master secret via a passkey + the WebAuthn PRF
extension.

**WebAuthn cannot store arbitrary key material directly** — it is a
signing protocol; private keys are generated inside the authenticator
and never leave. The PRF extension lets us *derive* a deterministic
32-byte secret from a passkey, which we use as a wrapping key for our
existing master secret.

```
[setup, one-time]
1. Existing master secret stays as-is (Phase A CryptoKey).
2. navigator.credentials.create({ publicKey: { extensions: { prf: {} }, ... } })
   → enrol a passkey in iCloud Keychain / Secure Enclave / TPM.
3. navigator.credentials.get({ ..., extensions: { prf: { eval: { first: SALT } } } })
   → first PRF output (32 bytes, deterministic for this passkey + salt).
4. Use PRF output as AES-GCM wrap key over the master secret.
5. Persist { wrappedMaster, iv, credentialId, salt } in IDB. Drop the
   plaintext master from storage.

[every app unlock]
1. navigator.credentials.get({ ..., extensions: { prf: { eval: { first: SALT } } } })
   → Touch ID / Face ID / Windows Hello.
2. Same passkey + same salt → same PRF output.
3. Unwrap the master secret in JS memory; immediately re-import as a
   non-extractable CryptoKey (Phase A).
```

**Properties:**

- PRF output never leaves the authenticator chain → JS → discarded.
- IDB content is useless without the device's biometric gesture.
- Master secret only exists in JS memory after explicit user consent.
- Per-session, not per-operation — unwrap once at app start, keep the
  CryptoKey for the session.

**UX cost**: one Touch ID / Face ID gesture per cold start (or after a
configurable lock interval).

**Browser support gate** — PRF extension:
- iOS 18+ Safari
- Chrome 132+
- Firefox 135+
- Older versions fall back to Phase A (software-only, no UX change).

**Make it opt-in**: a "Enable biometric protection" toggle in settings
that triggers the passkey enrolment flow. Users who don't opt in stay
on Phase A. Devices without PRF support hide the toggle entirely.

### Threat model summary

| Layer | Defends against |
| --- | --- |
| Today (base64) | nothing meaningful |
| Phase A | disk dump, forensic IDB extraction, accidental log/postMessage leaks |
| Phase B | + lost device, OS-level malware reading process heap (master not present until unlock) |

Neither phase defends against same-origin XSS that calls our
encrypt/decrypt functions — only WebAuthn's own UI gesture can gate
that, which is too disruptive for every operation. Mitigate XSS the
usual way (CSP, no `dangerouslySetInnerHTML` from network-sourced
content, etc.).

### Implementation order

1. Phase A first — universal, ~30 lines in `secureStorage.ts`,
   migration on startup.
2. Phase B as opt-in setting once Phase A ships and we have a way to
   detect PRF support cleanly. Treat as progressive enhancement.

---

## WebRTC Relay-Free Transport

**Status**: Planned

The relay currently proxies all data through the signaling server (WebSocket relay). This works reliably through any firewall that allows HTTPS, with ~50ms connection time and zero ICE/STUN overhead.

A future enhancement would add WebRTC as an **optional upgrade path**:

1. Peers connect via WebSocket relay (instant, always works)
2. In the background, attempt a WebRTC direct connection (ICE/STUN)
3. If ICE succeeds, transparently switch data flow to the direct WebRTC connection
4. If ICE fails (symmetric NAT, corporate firewall), stay on WebSocket relay

This gives the best of both worlds:
- **Reliability**: WebSocket relay as the guaranteed fallback
- **Performance**: Direct p2p when network topology allows (lower latency, no server bandwidth cost)

### Design Notes

- The `ws-relay` package should keep the transport layer swappable — the `Peer` abstraction should not assume WebSocket-only
- ICE candidate exchange can flow through the existing relay as signaling messages
- The upgrade should be transparent to application code (same message API)
- Consider using `simple-peer` or raw `RTCPeerConnection` for the WebRTC layer
