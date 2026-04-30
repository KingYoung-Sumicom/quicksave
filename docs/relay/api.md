# HTTP API

All endpoints return JSON and send `Access-Control-Allow-Origin: *` with `GET, PUT, OPTIONS` methods.

## Health & Stats

### `GET /health`

Basic health check. Returns connection summary and uptime.

```json
{
  "status": "ok",
  "connections": {
    "agents": 3,
    "pwas": 1
  },
  "uptime": 86400
}
```

### `GET /stats`

Detailed server statistics including ConnectionManager stats and SyncStore stats.

```json
{
  "connections": {
    "totalConnections": 150,
    "activeAgents": 3,
    "activePwas": 1,
    "activePwasByKey": 5,
    "peakAgents": 10,
    "peakPwas": 4,
    "peakPwasByKey": 12,
    "messagesRelayed": 5000,
    "uptime": 86400
  },
  "syncStore": {
    "blobs": 20,
    "tombstones": 2,
    "total": 22
  }
}
```

### `GET /metrics` (admin port only)

Prometheus exposition served by a separate HTTP server on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9090`). **Not** exposed on the public port. See [`deployment.md`](./deployment.md#prometheus-metrics) for the metric inventory and scraping notes.

## Sync Store

The sync store provides HTTP endpoints for persisting encrypted pairing data. Clients use it to back up and restore their pairing state across browser sessions.

The `keyHash` parameter is 8–64 alphanumeric characters (plus `-` and `_`), derived from the PWA's public key.

### `GET /sync/{keyHash}`

Retrieve a stored blob or tombstone.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Blob found | `{type: "blob", data: "..."}` |
| 410 | Tombstone exists (key was rotated) | `{type: "tombstone", data: "..."}` |
| 404 | No entry for this key | `{error: "not found"}` |

### `PUT /sync/{keyHash}`

Store an encrypted blob. Write is gated by a per-mailbox mutex and an
Ed25519-signed envelope (see [Sync Envelope](#sync-envelope) below).

**Request body**: `SignedSyncEnvelope` JSON with `action: 'sync-write'`.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Stored successfully | `{ok: true}` |
| 400 | Malformed envelope / action mismatch / missing ciphertext | `{error: "..."}` |
| 401 | Signature / timestamp / nonce verification failed | `{error: "signature verification failed", reason, serverTime}` |
| 409 | Mailbox locked by another writer (mutex held). `Retry-After` header in seconds; body `retryAfterMs`. | `{error: "mailbox locked", heldBy, retryAfterMs}` |
| 410 | Tombstone exists — writes blocked | `{error: "Tombstone exists", type: "tombstone", data}` |
| 413 | Blob exceeds size limit (8192 bytes) | `{error: "..."}` |

### `PUT /sync/{keyHash}/tombstone`

Write a tombstone to permanently seal this key's storage slot. Used during
key rotation.

**Request body**: `SignedSyncEnvelope` JSON with `action: 'sync-tombstone'`
and the signed tombstone payload as `ciphertext`.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Tombstone written | `{ok: true}` |
| 400 / 401 / 409 | Same envelope / mutex semantics as `PUT /sync/{keyHash}` | `{error: "..."}` |

### `DELETE /sync/{keyHash}/lock`

Explicitly release the per-mailbox mutex held by the caller. Used when a
client aborts a read-modify-write cycle (user cancel, upstream retry) so
the next writer doesn't have to wait for the 10 s TTL to elapse.

**Request body**: `SignedSyncEnvelope` JSON with `action:
'sync-lock-release'`. `ciphertext` must be absent or an empty string.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Result (may be `released: false` if the caller doesn't own the lock or it already expired) | `{released: boolean}` |
| 400 | Malformed envelope / action mismatch / ciphertext present | `{error: "..."}` |
| 401 | Signature / timestamp / nonce verification failed | `{error: "..."}` |

### Sync Envelope

All `/sync/*` writes (PUT blob, PUT tombstone, DELETE lock) use a single
signed envelope shape defined in `packages/shared/src/syncEnvelope.ts`:

```typescript
type SyncEnvelopeAction =
  | 'sync-write'
  | 'sync-tombstone'
  | 'sync-lock-release';

interface SignedSyncEnvelope {
  v: 1;
  action: SyncEnvelopeAction;
  ciphertext?: string;       // absent for sync-lock-release
  sigPubkey: string;         // base64url Ed25519 public key
  ts: number;                // unix ms; relay rejects stale/future
  nonce: string;             // base64url 16-byte random, replay-protected
  sig: string;               // base64url Ed25519 signature
}

// Signed canonical body (pipe-separated UTF-8):
//   `${action}|${sigPubkey}|${ts}|${nonce}|${keyHash}|${ciphertextHash}`
// ciphertextHash = urlsafe-base64(SHA-512(ciphertext bytes))
// For lock-release: ciphertextHash === ''
```

The relay also checks `action` matches the URL subpath, a TTL nonce cache
(shared across all `/sync/*` actions) to drop replays, and a ±skew window
on `ts`. `keyHash` and `ciphertextHash` are part of the signed body, so a
captured envelope cannot be replayed against a different mailbox or with
tampered ciphertext.

### Sync Data Formats

The `ciphertext` field is produced by the client before upload:

```typescript
// Blob: sealed-box encrypted backup of pairing state
interface SyncBlob {
  encryptedData: string;  // sealed-box ciphertext
  timestamp: number;
}

// Tombstone: signed proof of key rotation
interface Tombstone {
  type: 'rotated';
  oldPublicKey: string;
  signature: string;      // Ed25519 signature
}
```
