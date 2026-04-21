# 2026-04-21 Sync Re-architecture Plan

## Summary

切到「single shared `masterSecret` + multi-slot pairing mailbox + QR/URL + SAS」模型，並在 agent 端加上 TOFU + tombstone 自毀。

**Design doc**：`docs/guidelines/sync-security.md`

**Migration**：唯一使用者是開發者本人、會自行重 pair。**不做 in-place migration**，新版直接覆蓋舊 protocol。

**Ordering**：PWA UI/UX 先（可用 MockRelay 獨立 demo）→ relay backend → agent TOFU → 清理。

## Progress Legend

- `[ ]` 未開始
- `[~]` 進行中
- `[x]` 完成

---

## Stage A — PWA (UI + client crypto, mocked network)

目標：PWA 可以在**沒有真 relay 參與**的情境下 demo 完整 pairing 流程（兩個瀏覽器 tab 之間透過 MockRelay 單例對話）。

### A1. Shared crypto helper 擴充

- [x] `sasEncode(hmacOutput: Uint8Array, chars: number): string`，32 符號 alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- [x] `sasBucket(now: number, windowMs = 60_000): number`
- [x] `sasCompute(pubkey: Uint8Array, bucket: number): string`，封裝 HMAC 計算（以 SHA-512 + domain separation 實作）
- [x] `deriveSharedKeys(masterSecret: Uint8Array)` → `{ x25519: KeyPair, ed25519: SigningKeyPair }`，domain-separated SHA-512 seed → `nacl.box.keyPair.fromSecretKey` + `nacl.sign.keyPair.fromSeed`
- [x] **Files**: `packages/shared/src/crypto.ts`, `packages/shared/src/crypto.test.ts`
- [x] **Delegate tests**：46 個新測試由 subagent 產出，全綠（75 tests total in crypto.test.ts）

### A2. Pairing client lib（interface + MockRelay impl）

- [x] 定義 `PairTransport` interface：`postSlot / getSlots / deleteMailbox / subscribeToMailbox`
- [x] `MockRelay` 實作（module-level singleton、BroadcastChannel 跨 tab、64 槽 cap、TTL GC、測試可關閉 BC）
- [x] `PairClient` 類別：
  - A 側：`createInvite({ baseUrl, masterSecret, ttlMs?, sasWindowMs?, sasChars? })` → `{ pairUrl, qrData, eA_pubB64, addr, expiresAt, onCandidate, submitSAS, cancel }`
  - B 側：`acceptInvite({ pairUrl? | eA_pubB64? })` → `{ sas, bucket, sasExpiresAt, eB_pubB64, onSecret, cancel }`
- [x] Slot 解密 + SAS 過濾邏輯（0/1/2+ match 三條路；SAS 容忍 ±1 bucket 時鐘漂移）
- [x] Cancel / TTL 到期自動清 subscriptions
- [x] Pair URL 改用 HashRouter 格式 `/#/pair?k=<base64url>`（`k=` 仍在 fragment，不送到 server）
- [x] **Files**: `apps/pwa/src/lib/pairClient.ts`、`apps/pwa/src/lib/pairClient.test.ts`（40 tests 全綠）

### A3. Pairing UI / 路由 / state machine

- [x] Deep-link 路由 `/pair`（三處 `<Routes>` 都加，走 HashRouter `useSearchParams` 解 `k=`）
- [x] PWA manifest `url_handlers` 宣告（`pwa.quicksave.dev`、`quicksave.dev`）
- [x] `PairDeviceModal.tsx`（A 側）：QR 顯示（`qrcode` 產 data URL）+ 可複製 URL + SAS 輸入框 + TTL 倒數 + 候選計數
- [x] `JoinGroupPage.tsx`（B 側）：route-level 頁面、從 search params 解 `k`、大字 SAS 顯示 + 60s 倒數 + 成功/錯誤狀態
- [x] Error UX：0 match「沒有對上的裝置」、2+ match「偵測到可疑碰撞」（紅色 abort）、loading / 錯誤訊息
- [x] `ScanToJoinModal.tsx`（B 側相機入口）：用 `html5-qrcode` 掃 A 側 QR、成功後 `navigate('/pair?k=...')` 交給 JoinGroupPage
- [x] Settings 區塊重構：單顆按鈕拆成「邀請新裝置」+「連結到現有裝置」雙按鈕、各自配 sub-text
- [x] **Files**: `apps/pwa/src/routes/JoinGroupPage.tsx`、`apps/pwa/src/components/PairDeviceModal.tsx`、`apps/pwa/src/components/ScanToJoinModal.tsx`、`apps/pwa/src/App.tsx`（三處 Routes）、`apps/pwa/src/components/SettingsPage.tsx`（雙觸發按鈕）、`apps/pwa/vite.config.ts`（manifest url_handlers）

### A4. Stage A 驗收

- [x] Headless E2E（`pairClient.test.ts` happy path）：A 產 invite、B accept、A 收到 candidate、submitSAS → `{ status: 'sent' }`、B onSecret 收到原始 masterSecret bytes
- [x] 0 match / 2+ match / case-insensitive / wrong-length SAS、cancel idempotent、ciphertext 不可由第三者解 — 全部自動測
- [x] 所有 Stage A 測試通過：`packages/shared` 97 tests、`apps/pwa` pairClient 40 tests
- [ ] **User action**：`pnpm dev:pwa`、兩 tab 手動 UI 驗收（A = Settings → 加入新裝置（SAS）；B = 開 `#/pair?k=...` URL）

---

## Stage B — Relay backend + 串回真實網路

### B1. Multi-slot pair mailbox

- [ ] `PairSlot` / `PairMailbox` 資料結構（append-only、cap 64、TTL 5 min）
- [ ] Garbage collector（setInterval 掃過期 mailbox）
- [ ] **Files**: `apps/relay/src/pairStore.ts`（新檔）、`apps/relay/src/pairStore.test.ts`

### B2. Pair HTTP routes

- [ ] `POST /pair-requests/{hash}` append slot（回 slot_id）
- [ ] `GET /pair-requests/{hash}` 回整個 slots array
- [ ] `DELETE /pair-requests/{hash}` 立即清除
- [ ] Per-IP rate-limit（複用既有 middleware）
- [ ] **Files**: `apps/relay/src/index.ts`

### B3. Pubsub topic extensions

- [ ] `pair:{hash}` topic：`POST /pair-requests/*` 成功後 emit `{ slot_id }`
- [ ] `tombstone:{hash}` topic：既有 tombstone 寫入流程追加 publish
- [ ] **Files**: `apps/relay/src/index.ts`、`apps/relay/src/syncStore.ts`

### B4. Signed sync envelope + per-mailbox mutex

- [ ] `SignedSyncEnvelope` schema 驗證（Ed25519 verify on PUT/DELETE `/sync/*`）
- [ ] Per-mailbox in-flight mutex（`inFlight: Map<hash, {sigPubkey, acquiredAt}>`）
- [ ] HTTP 409 回傳 + client 端退避重試邏輯（在 `apps/pwa/src/lib/syncClient.ts`）
- [ ] Cancel route `DELETE /sync/{hash}/lock`
- [ ] **Files**: `apps/relay/src/syncStore.ts`, `apps/relay/src/index.ts`, `apps/pwa/src/lib/syncClient.ts`

### B5. 換掉 MockRelay

- [ ] `HttpPairTransport` 實作 `PairTransport` interface（覆寫 A2 的 MockRelay）
- [ ] E2E test：兩個瀏覽器 / 兩個 vitest context pair 成功
- [ ] 手動驗證：桌機 Chrome + 手機 PWA 實機 pair

### B6. Stage B 驗收

- [ ] 所有 pairing flow E2E 測試通過
- [ ] 兩台 PWA 成功同步 `masterSecret` 與 machine list
- [ ] 409 退避在人為製造競爭下正確收斂

---

## Stage C — Agent TOFU + tombstone 自毀

可與 Stage B 並行（不同 app、不同檔案）。

### C1. Agent config schema

- [ ] `peerPWAPublicKey: string | null`、`peerPWASignPublicKey: string | null` 加入 `AgentConfig`
- [ ] Config migration：舊 config 讀到 `null` 視為 unpaired
- [ ] **Files**: `apps/agent/src/config.ts`

### C2. Handshake 驗簽

- [ ] V2 handshake 協議擴充：PWA 端要對 agent 出題的 challenge 以共用 Ed25519 私鑰簽名
- [ ] Agent 端：unpaired 時接受第一個 handshake 並寫入 config（TOFU）；paired 時要求簽章對 stored pubkey 驗過才接受
- [ ] **Files**: `apps/agent/src/connection/connection.ts: handleKeyExchange`、對應 PWA 端 `apps/pwa/src/lib/websocket.ts` 或 `sessionManager`

### C3. Tombstone pubsub 訂閱 + 自毀

- [ ] Agent relay 連線時訂閱 `tombstone:{hash(peerPWAPublicKey)}`
- [ ] 收到事件 → `verifyTombstone(payload, peerPWASignPublicKey)` → 通過則：
  - 清 config 的 `peerPWA*` 欄位
  - 產新的 agent keypair
  - 清所有 session state
  - 關閉 relay 連線、拒絕入站 handshake
- [ ] **Files**: `apps/agent/src/connection/connection.ts`、`apps/agent/src/state.ts`

### C4. 自閉模式 + CLI 解鎖

- [ ] Agent state 新增 `'unpaired' | 'paired' | 'closed'` 明確狀態
- [ ] `quicksave pair` CLI：檢查 state，若 `closed` 則先清理再進 `unpaired`；產 invite URL；等 TOFU
- [ ] `quicksave status` 顯示當前 state
- [ ] **Files**: `apps/agent/src/state.ts`、`apps/agent/src/cli/pair.ts`、`apps/agent/src/cli/status.ts`

### C5. Stage C 驗收

- [ ] 全新 agent 跑 `quicksave pair`，一台 PWA 接上、config 寫入 `peerPWA*`
- [ ] 第二台 PWA（用同 masterSecret 派生 keypair）能接上（signing pubkey 相同）
- [ ] PWA 端跑 rotate-keys → agent 自動進 closed、連線拒絕
- [ ] `quicksave pair` 後 agent 能重新進 paired

---

## Stage D — 清理 + 文件

### D1. 移除舊的 per-PWA identity 程式

- [ ] `identityStore.ts` 刪除 `pairedDevices` 相關欄位與 action
- [ ] 刪除與 endorsement / roster 有關的 code 與 type
- [ ] 刪除不再用到的 sync helpers（若有）
- [ ] **Files**: `apps/pwa/src/stores/identityStore.ts`、`packages/shared/src/types.ts`

### D2. 文件同步

- [ ] `docs/references/quicksave-architecture.md` §三（AgentConnection）、§六（PWA store）更新
- [ ] 檢查 `CLAUDE.md` 文件同步表格中受影響的條目
- [ ] `docs/guidelines/sync-security.md` 若實作過程有偏離設計，同步修正

### D3. 清空我自己的測試資料

- [ ] 清空 dev agent 的 `~/.quicksave/`
- [ ] 清空 dev PWA 的 IndexedDB / localStorage
- [ ] 重跑一次完整 bootstrap（agent pair + PWA pair 多裝置），確認 fresh state 流程可走

---

## Risk / Watch-out

1. **PWA `url_handlers` 支援度**：Safari / Firefox 對 `url_handlers` 支援弱，deep link 可能仍需 fallback 到網頁版 pair route。Stage A3 做 UI 時要測三個瀏覽器。
2. **BroadcastChannel 做 MockRelay 的限制**：只跨同源 tab，不跨 origin。夠做 Stage A demo，但別把它當整合測試基準。
3. **Handshake 協議改動相容性**：Stage C2 會動 V2 key-exchange。舊的 PWA（只會 V2 無簽章）連上新 agent 會失敗——目前是 breaking change，但使用者只有一人、會自己重 pair，可接受。
4. **Per-mailbox mutex 在 relay restart 後的行為**：In-flight 狀態全失，client 端要能從 409 / 200 無狀態地往前走。Stage B4 測這個。
5. **Tombstone pubsub 遺漏**：agent 離線時 tombstone 事件會錯過。第一版接受「重連時主動查一次舊 mailbox 狀態」作為 catch-up（開 `GET /sync/{hash}` 取 410 即自毀）。

---

## Suggested starting point

**A1 + A3 並行**：
- A1 是 pure function、可獨立 TDD，交一份 spec 給 subagent 生測試最適合
- A3 可以先做靜態 mockup（不串 state machine），確認 UI 長相與路由

兩者在 A2 合流。
