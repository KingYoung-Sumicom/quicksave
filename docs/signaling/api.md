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

Store an encrypted blob.

**Request body**: Raw string data (the encrypted blob).

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Stored successfully | `{ok: true}` |
| 410 | Tombstone exists — writes blocked | `{error: "tombstone exists"}` |
| 413 | Blob exceeds size limit (8192 bytes) | `{error: "..."}` |

### `PUT /sync/{keyHash}/tombstone`

Write a tombstone to permanently seal this key's storage slot. Used during key rotation.

**Request body**: Raw string data (the signed tombstone).

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Tombstone written | `{ok: true}` |
| 409 | Tombstone already exists | `{error: "tombstone already exists"}` |

### Sync Data Formats

Data stored in the sync store is encrypted by clients before upload:

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
