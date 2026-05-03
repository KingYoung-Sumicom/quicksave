# Image & File Attachments — Claude Code (Phase 1)

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user attach images (and small text files / PDFs) to a chat message in the PWA, ship them to the agent, and forward them as Anthropic content blocks to the Claude Code provider (CLI + SDK). Other providers (Codex, future) come in a later phase.

**Why Claude Code first:** the SDK message shape (`SDKUserMessage.message: MessageParam`) already accepts the Anthropic `MessageParam` content-block array, and the CLI accepts the same JSON over stdin. No protocol invention is needed on the model side — only on our own PWA→Agent path.

**Transport model: always pre-upload via chunked staging.** Files start uploading the moment they're attached (paste/drop/pick), with a per-chip progress bar. The send payload only carries `attachmentIds: string[]`; the agent resolves them from a short-lived staging map. There is **no inline fallback** — uniform shape regardless of size, natural cancel/retry, no per-frame size ceiling, and pre-warmed bytes by the time the user hits send.

---

## Scope

### In scope (Phase 1)

| Type | How | Notes |
|------|-----|-------|
| **Images** (png/jpeg/gif/webp) | `{ type: 'image', source: { type: 'base64', media_type, data } }` content block | Native Claude support. ≤5 MB raw per image. |
| **PDFs** | `{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }` | Native Claude support since Sonnet 3.5+. ≤32 MB. |
| **Text files** (≤256 KB, mime `text/*`, `application/json`, etc.) | Decoded and inserted as a fenced text block in the user prompt | Cheap and self-evident to the model. |
| **Long pasted text** (>1500 chars in `onPaste`) | Auto-collapsed in the composer into a `kind: 'text'` attachment chip (`name: 'pasted-N.txt'`) — same pipeline as a pasted text file | Mirrors Claude.ai / ChatGPT UX. Below the threshold the paste lands in the textarea normally. |

All four flow through the **same chunked-upload + staging path** described below.

### Out of scope (Phase 2+)

- Arbitrary binaries (e.g. `.zip`, `.docx`, large logs) — punt to a workspace-side write under `<cwd>/.quicksave/uploads/<sessionId>/` and surface the path in the prompt so Claude Code can `Read`/`Bash` it.
- Other providers (Codex etc.) — handled when each provider's input shape is known.
- Resume-time attachments. Phase 1 supports attachments on first turn AND on follow-up turns (`sendUserMessage`); explicit "resume previous session with new attachments" works because resume reuses the same content-block path.
- Drag-and-drop reordering or attachment editing post-send.

### UX cases we must handle

1. **Paste** an image from clipboard into composer → preview chip appears, send includes it.
2. **Drag-and-drop** files onto the composer → previews, send.
3. **Click 📎 button** → file picker → select one or more.
4. **Remove** a chip before sending.
5. **Send while disconnected** — the optimistic user card must show the attachment chip; on reconnect the queued command flushes.
6. **Reload mid-conversation** — past user-message attachments must re-render from agent history (not just from the local optimistic card).

---

## Architecture overview

```
┌────────────────────┐
│ PWA composer       │  attach (paste/drop/pick or long-paste)
│                    │  → assigns attachmentId locally
│                    │  → starts chunked upload immediately
└──────────┬─────────┘
           │  attachment:upload  (chunk 1..N, with progress acks)
           ▼
┌────────────────────┐
│ Agent staging map  │   Map<deviceId, Map<attId, StagedAttachment>>
│  (TTL 10 min,      │   Holds bytes until referenced by a send,
│   per-device cap)  │   or evicted on cancel / TTL / disconnect.
└──────────┬─────────┘
           │
           ▼  (later, when user hits Send)
┌────────────────────┐  attachmentIds: string[]   ┌───────────────────────┐
│ claude:start /     │ ─────────────────────────▶ │ messageHandler        │
│ claude:sendInput   │                            │  → resolve from       │
│  (no bytes here)   │                            │    staging by id      │
└────────────────────┘                            │  → SessionManager     │
                                                  │  → CodingAgentProvider│
                                                  └───────────┬───────────┘
                                                              │ MessageParam content[]
                                                              ▼
                                                  ┌───────────────────────┐
                                                  │ Claude Code (CLI/SDK) │
                                                  └───────────────────────┘
```

**Three records, one shape:**
- `AttachmentMetadata` — `{ id, kind, mime, name, size }`. What flows on `UserCard.attachments[]` and any list/snapshot surface. **No bytes.**
- `Attachment` — `AttachmentMetadata + { data: base64 }`. Lives in PWA composer state (between pick and send), agent staging (between upload and consume), and `attachment:fetch` responses (one round trip per id, then PWA-cached).
- `AttachmentRef` — `{ id }`. The only thing that travels in `claude:start` / `claude:resume` payloads.

**Bytes never ride card snapshots.** When a card carrying attachments renders, the PWA looks up the metadata id in its L1+L2 attachment cache; on miss it issues `attachment:fetch { sessionId, attachmentId }`. The agent stores bytes side-by-side with the JSONL under `<state>/attachments/<sessionId>/<id>.bin` + `.meta.json` at `staging.consume()` time, and serves them from disk. Same-tab uploads pre-populate the cache via `primeUploadedAttachment(sessionId, id)` so the sender never re-fetches.

The agent converts staged `Attachment` → Anthropic `ContentBlock` at the provider boundary.

---

## File structure

| File | Change |
|------|--------|
| `packages/shared/src/attachments.ts` | **NEW** — `Attachment`, `AttachmentRef`, upload chunk payload types, limit constants |
| `packages/shared/src/cards.ts` | **MODIFY** — add `attachments?: Attachment[]` to `UserCard` |
| `packages/shared/src/types.ts` | **MODIFY** — add `attachmentIds?: string[]` to `ClaudeStartRequestPayload`, `ClaudeResumeRequestPayload`, `ClaudeSendInputRequestPayload`; new `AttachmentUploadRequestPayload` / `AttachmentCancelRequestPayload` |
| `packages/shared/src/index.ts` | **MODIFY** — re-export new types |
| `apps/agent/src/ai/attachmentStaging.ts` | **NEW** — staging map keyed by `(deviceId, attachmentId)`, accept-chunk / finalize / consume / cancel / GC |
| `apps/agent/src/handlers/messageHandler.ts` | **MODIFY** — handle `attachment:upload` and `attachment:cancel`; on `claude:start`/`sendInput`, resolve `attachmentIds` from staging before forwarding |
| `apps/agent/src/handlers/legacyBusAdapter.ts` | **MODIFY** — add `attachment:upload` and `attachment:cancel` to `LEGACY_BUS_VERBS` (CLAUDE.md gotcha) |
| `apps/pwa/src/lib/attachments.ts` | **NEW** — `fileToAttachment(File)`, `pasteToAttachments(ClipboardEvent)`, mime/size guards, base64 chunker |
| `apps/pwa/src/lib/attachmentUploader.ts` | **NEW** — upload manager: queue chunks, track progress per id, expose `useAttachmentUpload(id)` |
| `apps/pwa/src/components/AttachmentChip.tsx` | **NEW** — thumbnail/icon + filename + progress bar + remove button |
| `apps/pwa/src/components/AttachmentTray.tsx` | **NEW** — strip of chips above the textarea |
| `apps/pwa/src/components/ClaudePanel.tsx` | **MODIFY** — wire paste/drop/picker, long-paste auto-collapse, render tray, gate send on uploads-ready, pass `attachmentIds` to `handleSend` |
| `apps/pwa/src/hooks/useClaudeOperations.ts` | **MODIFY** — accept `attachmentIds` and pass through `sendCommand` |
| `apps/pwa/src/stores/claudeStore.ts` | **MODIFY** — optimistic-append carries `attachments`; dedupe by `(text, sortedAttachmentIds)` |
| `apps/pwa/src/components/chat/UserCardView.tsx` (or equivalent) | **MODIFY** — render attachment chips under user text |
| `apps/agent/src/ai/provider.ts` | **MODIFY** — `StartSessionOpts.attachments?: Attachment[]`, ditto resume, `ProviderSession.sendUserMessage(prompt, attachments?)` |
| `apps/agent/src/ai/sessionManager.ts` | **MODIFY** — pipe `attachments` (already resolved by messageHandler) to provider |
| `apps/agent/src/ai/contentBlocks.ts` | **NEW** — `attachmentsToContentBlocks(text, attachments) → MessageParam['content']` |
| `apps/agent/src/ai/claudeSdkProvider.ts` | **MODIFY** — call `attachmentsToContentBlocks` instead of passing the bare prompt string |
| `apps/agent/src/ai/claudeCliProvider.ts` | **MODIFY** — same; the CLI accepts the same `MessageParam` shape via stdin |
| `apps/agent/src/ai/cardBuilder.ts` | **MODIFY** — `userMessage(text, attachments?)` so streamed `UserCard` mirrors what the PWA already showed |
| `docs/references/quicksave-architecture.en.md` | **MODIFY** §四 (message types) and §三 (new staging path) |

---

## Data model

```typescript
// packages/shared/src/attachments.ts
export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface Attachment {
  /** Stable id (UUID v4) — generated client-side, persists for the lifetime of the chip. */
  id: string;
  kind: AttachmentKind;
  /** IANA media type, e.g. 'image/png', 'application/pdf', 'text/markdown'. */
  mimeType: string;
  /** Display filename (no path). For long-paste collapse: 'pasted-1.txt' etc. */
  name: string;
  /** Raw byte size of the decoded payload. */
  size: number;
  /**
   * Base64-encoded payload (no data: prefix).
   * For 'text' kind, this is base64(utf8 bytes) — keeps wire shape uniform.
   */
  data: string;
}

/** What the send payload carries — id only. */
export interface AttachmentRef {
  id: string;
}

/** Chunked-upload wire types. */
export interface AttachmentUploadRequestPayload {
  attachmentId: string;
  /** Sent on the first chunk only. */
  meta?: { kind: AttachmentKind; mimeType: string; name: string; size: number; totalChunks: number };
  /** 0-indexed. */
  chunkIndex: number;
  /** Base64 of this chunk's bytes. ~512 KB raw per chunk → ~700 KB base64. */
  chunk: string;
}
export interface AttachmentUploadResponsePayload {
  attachmentId: string;
  /** Bytes received so far (post-decode). */
  receivedBytes: number;
  /** True once final chunk arrived and the staged record is complete. */
  ready: boolean;
}
export interface AttachmentCancelRequestPayload { attachmentId: string }

export const ATTACHMENT_LIMITS = {
  image: { maxBytes: 5 * 1024 * 1024,  mimes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
  pdf:   { maxBytes: 32 * 1024 * 1024, mimes: ['application/pdf'] },
  text:  { maxBytes: 256 * 1024,       mimes: ['text/*', 'application/json', 'application/xml'] },
} as const;

export const CHUNK_BYTES        = 512 * 1024;        // raw, before base64
export const PER_MESSAGE_MAX_COUNT = 5;
export const STAGING_TTL_MS     = 10 * 60 * 1000;    // GC orphans
export const PER_DEVICE_STAGING_MAX_BYTES = 128 * 1024 * 1024;
export const LONG_PASTE_THRESHOLD_CHARS = 1500;
```

**Why base64 inside JSON and not raw binary frames?** The transport is JSON over encrypted+gzipped WebSocket (`apps/pwa/src/lib/websocket.ts:133-148`). A binary side-channel would touch the encryption envelope. ~33% base64 overhead is acceptable per chunk; the ceiling concern goes away because we chunk anyway.

---

## Transport considerations

- **Per-frame size:** each `attachment:upload` chunk is ~700 KB base64 (~1 MB after gzip+AES envelope). Comfortably under any reasonable `ws.maxPayload`. Still good practice to **verify** `apps/relay`'s `maxPayload` setting and document it.
- **Compression:** gzip on base64 is ~0% effective; we accept the wash on the chunk field. Other text fields in the same frame still compress.
- **Encryption:** unchanged — chunks ride the existing encrypted payload.
- **Concurrency:** the upload manager streams up to N chunks in flight per attachment (start with N=2) to overlap RTT without overwhelming the link. Multiple attachments upload in parallel.
- **Disconnect:** in-flight uploads pause; on reconnect, the manager **resumes from the next un-acked chunk** (the agent's staging record exposes `receivedBytes` so PWA knows where to pick up). If staging GC'd the record (long disconnect), restart from chunk 0.
- **Send-time gate:** the send button is disabled while any chip is `uploading`. A chip flips to `ready` when the final chunk's response carries `ready: true`. (We can later relax this — agent-side wait — but disabled-send is the simplest first version.)
- **Cancel:** removing a chip mid-upload aborts the in-flight chunk and sends `attachment:cancel`. Agent evicts staging immediately.
- **Pre-warm edge case:** even tiny attachments (e.g. a clipboard 4 KB PNG) go through staging. The single chunk completes in one round-trip, which is roughly the same as putting the bytes in the send payload — no observable downside, and the code path stays uniform.

---

## Agent → Claude content-block mapping

```typescript
// apps/agent/src/ai/contentBlocks.ts
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import type { Attachment } from '@sumicom/quicksave-shared';

export function attachmentsToContentBlocks(
  prompt: string,
  attachments?: Attachment[],
): MessageParam['content'] {
  if (!attachments || attachments.length === 0) return prompt;

  const blocks: Exclude<MessageParam['content'], string> = [];

  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mimeType as any, data: a.data },
      });
    } else if (a.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
      });
    } else if (a.kind === 'text') {
      const decoded = Buffer.from(a.data, 'base64').toString('utf8');
      blocks.push({
        type: 'text',
        text: `<<<file:${a.name}>>>\n${decoded}\n<<<end:${a.name}>>>`,
      });
    }
  }

  // Trailing user prompt last so the model reads attachments first.
  if (prompt) blocks.push({ type: 'text', text: prompt });

  return blocks;
}
```

`SDKUserMessage.message` is `MessageParam` (`sdk.d.ts:2918-2931`), and the CLI accepts the same JSON via stdin (`claudeCliProvider.ts:307`). One helper covers both providers.

---

## History replay (reconnect / refresh)

When the PWA reconnects, `getCards` returns the agent's recorded `Card[]`. Today `UserCard.text` is rebuilt from the CLI's JSONL session log; the JSONL records full content blocks already. To restore attachments:

1. **`cardBuilder.userMessage(text, attachments?)`** records both fields when a turn starts (CLI provider line 296, SDK provider line 69).
2. **`cardBuilder.fromHistoryJsonl`** (or the equivalent backfill path) parses image/document content blocks back into `Attachment` records when reading the JSONL on session resume. Image data round-trips because we wrote it; PDFs and text the same.
3. The streaming `add` event for the user card already carries the full card object — just include `attachments`.

**Open question:** PII/storage policy. Embedding base64 image data in `cardBuilder` history means it's also held in agent memory and (for CLI provider) the JSONL on disk. The CLI already does this natively, so we are not making it worse, but flagging it.

---

## UX details

- **Chip layout:** a horizontal strip directly above the textarea (`ClaudePanel.tsx:581`). Each chip = thumbnail (image) or icon (PDF/text) + filename + size + ✕ button.
- **Paste:** `onPaste` reads `e.clipboardData.items` for `kind === 'file'`.
- **Drop:** `onDragOver` (preventDefault) + `onDrop` reads `e.dataTransfer.files`. Whole composer panel acts as drop target with a highlight border while dragging.
- **Picker:** hidden `<input type="file" multiple accept="image/*,application/pdf,text/*">` triggered by the 📎 button.
- **Validation:** reject by mime/size with a toast; never silently truncate.
- **Mobile:** the existing skip-Enter-on-mobile rule (commit `60fcafb`) still applies; nothing else mobile-specific in Phase 1.
- **Optimistic card:** after `handleSend`, append a `UserCard { text, attachments }` to the store *before* awaiting the bus response (today's pattern at `useClaudeOperations.ts:147`). Dedupe on agent-echoed user message must compare on `(text, attachments[].id)` so the optimistic card replaces cleanly.

---

## Tasks

### Task 0: Staging infrastructure + upload protocol

- [ ] **Step 0.1** Define `Attachment`, `AttachmentRef`, `AttachmentUploadRequestPayload`, `AttachmentUploadResponsePayload`, `AttachmentCancelRequestPayload`, and limit constants in `packages/shared/src/attachments.ts`. Re-export from index.
- [ ] **Step 0.2** Create `apps/agent/src/ai/attachmentStaging.ts`:
  - `Map<deviceId, Map<attachmentId, StagedAttachment>>`
  - `acceptChunk(deviceId, payload) → AttachmentUploadResponsePayload` — appends to a `Buffer[]`, validates running size against the kind's `maxBytes`, sets `ready` when `chunkIndex === totalChunks - 1`.
  - `consume(deviceId, attachmentIds) → Attachment[]` — atomically removes and returns; throws on missing/not-ready id.
  - `cancel(deviceId, attachmentId)` — evict.
  - `gc()` — drop entries past `STAGING_TTL_MS`; called from a 60 s `setInterval` and on device disconnect.
  - Per-device byte cap: reject chunks that would push the device over `PER_DEVICE_STAGING_MAX_BYTES`.
  - Tests for accept/consume/cancel/cap/TTL.
- [ ] **Step 0.3** Wire `attachment:upload` and `attachment:cancel` verbs in `messageHandler.ts`. Add both to `LEGACY_BUS_VERBS` in `legacyBusAdapter.ts` (CLAUDE.md gotcha — both required).
- [ ] **Step 0.4** Create `apps/pwa/src/lib/attachmentUploader.ts`:
  - Per-attachment state machine: `queued → uploading(progress) → ready | error | cancelled`.
  - Concurrency: 2 chunks in flight per attachment, multiple attachments in parallel.
  - Resume on reconnect by reading the last response's `receivedBytes`.
  - Exposes a small store/hook (`useAttachmentUpload(id)`) the chips subscribe to.
- [ ] **Step 0.5** Update `docs/references/quicksave-architecture.en.md` §三 with the staging-and-resolve flow; §四 with the new verbs.

### Task 1: Card + send-payload types

- [ ] **Step 1.1** Extend `UserCard` in `packages/shared/src/cards.ts` with `attachments?: Attachment[]`.
- [ ] **Step 1.2** Extend `ClaudeStartRequestPayload`, `ClaudeResumeRequestPayload`, and `ClaudeSendInputRequestPayload` in `packages/shared/src/types.ts` with `attachmentIds?: string[]`. (Note: bytes do **not** travel here — they're already staged.)

### Task 2: PWA composer

- [ ] **Step 2.1** Create `apps/pwa/src/lib/attachments.ts` with `fileToAttachment(File)`, `attachmentsFromDataTransfer(DataTransfer)`, mime/size validation with friendly error strings, and `pasteToAttachments(ClipboardEvent)` that handles both file items and long-text auto-collapse:
  - If any `clipboardData.items[i].kind === 'file'` → those become attachments.
  - Else if `clipboardData.getData('text/plain').length > LONG_PASTE_THRESHOLD_CHARS` → preventDefault, create a single `kind: 'text'` Attachment with `name: 'pasted-N.txt'` (N counts existing pasted-* chips in the tray) and `mimeType: 'text/plain'`.
  - Else → return `[]` (let the textarea handle the paste normally).
- [ ] **Step 2.2** Create `AttachmentChip.tsx` — thumbnail (image), icon (pdf/text), filename, size, **progress bar** (subscribed via `useAttachmentUpload(id)`), error state with retry, ✕ button. Removing the chip aborts the upload + calls `attachment:cancel`.
- [ ] **Step 2.3** Create `AttachmentTray.tsx` — strip of chips above the textarea.
- [ ] **Step 2.4** Wire `onPaste`, `onDragOver`+`onDrop`, and a hidden file input (📎 button) in `ClaudePanel.tsx`. Each new attachment immediately enters the upload manager (Task 0.4); chip renders progress.
- [ ] **Step 2.5** Persist *only* the attachment metadata + ids in the draft localStorage (not the bytes — those are at most 10 min in agent staging). On rehydrate, ping the agent for staging status; chips that aren't `ready` get a "needs re-upload" state with a re-pick button. Below threshold (e.g. <128 KB) we can also keep base64 in localStorage so refresh truly survives.
- [ ] **Step 2.6** Gate the send button: disabled while any chip is `uploading`. `handleSend` collects `attachmentIds` from `ready` chips and passes them through `useClaudeOperations`.
- [ ] **Step 2.7** Extend optimistic `appendCard` and the dedupe key in `claudeStore.ts` to include sorted `attachmentIds`.
- [ ] **Step 2.8** Render attachments in the user message view (read-only chips, no progress bar, click image to open lightbox).

### Task 3: Agent provider plumbing

- [ ] **Step 3.1** Add `attachments?: Attachment[]` to `StartSessionOpts`, `ResumeSessionOpts`, and `ProviderSession.sendUserMessage(prompt, attachments?)` in `apps/agent/src/ai/provider.ts`.
- [ ] **Step 3.2** Create `apps/agent/src/ai/contentBlocks.ts` with `attachmentsToContentBlocks` + unit tests.
- [ ] **Step 3.3** Update `claudeSdkProvider.ts` (3 call sites: `startSession` line 123, `resumeSession` line 159, `sendUserMessage` line 74) to use the helper.
- [ ] **Step 3.4** Update `claudeCliProvider.ts` (`startSession`/`resumeSession` line 408/428, `sendUserMessage` line 289, `spawnAndConsume` line 502) the same way.
- [ ] **Step 3.5** `cardBuilder.userMessage(text, attachments?)`; record on the in-memory user card. (CLI's JSONL replay already preserves the content-block array, so refresh from history works.)
- [ ] **Step 3.6** `messageHandler.ts:1898` (`claude:start`) and the `sendInput` / resume paths — call `attachmentStaging.consume(deviceId, payload.attachmentIds)` to materialize `Attachment[]`, then pass to `sessionManager`. Surface a clean error (`attachment_not_ready` / `attachment_not_found`) if `consume` throws.

### Task 4: Tests

Delegate to a fresh `general-purpose` subagent with this spec (per CLAUDE.md test rule):

- `attachmentStaging` — accept-then-consume happy path; reject duplicate `chunkIndex`; out-of-order chunks; oversize blocks; per-device cap; TTL eviction; cancel.
- `attachmentsToContentBlocks` — image-only, pdf-only, text-only, mixed, empty, prompt-only (passthrough), order (attachments before trailing prompt).
- `claudeSdkProvider` send path — given `{ prompt, attachments }`, the queued `SDKUserMessage.message.content` is the expected block array.
- `claudeCliProvider` send path — the JSON written to stdin matches.
- `cardBuilder.userMessage` — round-trip: input attachments → emitted card → re-parse from JSONL on simulated reconnect (mock the JSONL read).
- `messageHandler` — `attachment:upload` chunks staged correctly; `claude:start` with `attachmentIds` resolves them; missing/not-ready id returns the expected error.
- PWA `attachments.ts` — validation rejects oversized, wrong-mime, too-many; `pasteToAttachments` handles file items, plain-text below threshold (passthrough), plain-text above threshold (auto-collapse to 'pasted-N.txt'), mixed.
- PWA `attachmentUploader` — chunk ordering, concurrency cap, retry on chunk failure, cancel mid-upload, resume after disconnect using `receivedBytes`.

### Task 5: Docs & wiring

- [ ] **Step 5.1** Update `docs/references/quicksave-architecture.en.md` §三 (staging-and-resolve transport flow) and §四 (`attachment:upload` / `attachment:cancel` verbs + `attachmentIds` field).
- [ ] **Step 5.2** Update `apps/pwa/README.md` quick-start if there's anything composer-facing.

---

## Open questions for the user

1. **Long-paste threshold** — 1500 chars is a reasonable default; ChatGPT uses ~1000, Claude.ai ~1500-ish. OK with 1500?
2. **Send-while-uploading** — Phase 1 disables Send until all chips are `ready`. Acceptable? The agent-side wait variant is cleaner UX (Send always works, agent waits ≤Ns) but a bit more code.
3. **Phase 2 scope** — when do non-image, non-PDF binaries become a real ask? If it's near-term, we should design the workspace-write path now even though we don't ship it.
4. **Provider parity** — do you also want this Phase 1 to cover Codex now, or strictly Claude Code? (Plan above is Claude-only; Codex needs its own input shape research.)
