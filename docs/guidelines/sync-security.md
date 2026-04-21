# PWA ↔ PWA Sync Security

如何在多台 PWA client 之間安全同步「設備（agent running machines）」資訊與帳號設定。
本文件鎖定**單用戶應用**情境（每位使用者持有自己的一組 PWA 裝置；relay 為跨用戶共享、無帳號狀態）。

整體設計向 [Happy Coder](https://github.com/slopus/happy) 收斂：**所有同一帳號的 PWA 共用一把 `masterSecret`，所有加解密 / 簽章金鑰皆由它派生。** 沒有 per-PWA 身分、沒有白名單、沒有 endorsement 傳播。

## Threat Model

**信任邊界**：

- **互信**：使用者持有的 PWA 裝置們（共用 `masterSecret` ⇒ 同一個 cryptographic principal）
- **不信任**：relay（best-effort 暫存層；可能被逆向 / 故障 / 換手）
- **可被觀察**：mailbox 位址 `hash(shared_pubkey)`（外部攻擊者可能透過流量分析猜中）

**要防的攻擊**：

| 威脅 | 機制 |
|---|---|
| Forgery | 攻擊者寫入冒充合法裝置的 sync blob，下次同步即遭注入惡意 `Machine`、進而被 MITM agent 連線 |
| LWW spoof | 攻擊者把 `updatedAt` 設成極大值，讓偽造項目蓋過合法項目（forgery 的特例） |
| Mailbox spam / DoS | 攻擊者持續 PUT 垃圾，蓋掉合法 sender 的單槽 mailbox blob，造成同步失效 |
| Pairing impersonation | 加入新 PWA 時，攻擊者攔截 pairing channel，把惡意 `masterSecret` 推給新裝置（之後就能讀寫 mailbox） |

**不在此文件範圍內**：

- Relay 程式碼本身的弱點（注入、超載防護等基礎服務治理）
- 端裝置完全淪陷後的後續攻擊（裝置上的 IndexedDB `masterSecret` 被竊）
- 使用者透過 phishing 主動把 `masterSecret` 交出去

## Identity Model

`masterSecret`（32 bytes）是唯一的根憑證。所有需要的 keypair 都從它派生：

| Key | 派生方式 | 用途 |
|---|---|---|
| 共用 X25519 keypair | `crypto_box_seed_keypair(masterSecret)`（或等效 KDF） | sealed-box 加解密 sync mailbox blob |
| 共用 Ed25519 signing key | `crypto_sign_seed_keypair(masterSecret)` | 簽 sync blob 與 cancel / lock 請求 |

**關鍵性質**：

- 所有 paired PWA 派生出**完全相同**的 keypair → mailbox 位址（`hash(shared_pubkey)`）對全群只有一個
- 持有 `masterSecret` ⇔ 是合法成員。沒有「誰是哪一台」的 cryptographic 區分
- 裝置暱稱（`nickname`）只是 UI 上的方便標籤，**不參與任何驗章 / 授權決策**

派生工作放在 `packages/shared/src/crypto.ts`；secureStorage 只保存 `masterSecret`，不再存 per-device keypair。

### 為什麼放棄 per-PWA crypto identity

在前一版設計中，我們嘗試讓每台 PWA 有自己的 X25519 + Ed25519 keypair，並維護 `pairedDevices` 白名單。檢視每個原本想解決的問題：

| 想解決 | 重新評估 |
|---|---|
| 區分「哪台裝置寫的」做事後追蹤 | 單用戶情境下沒人會去追蹤；要做要靠 monitoring，per-device 簽章不解此問 |
| 踢掉特定裝置 | 退役裝置 = user 自己清空 browser storage（routine retirement）；裝置遺失 = 整群 reset（換 `masterSecret`）；都不需要白名單 |
| 防 forgery | `masterSecret` 共用後，「合法成員」與「持有 key 的攻擊者」cryptographic 上不可區分 → 不靠白名單，靠保護 `masterSecret` 與 mailbox 位址不外洩 |

結論：複雜度全部刪除。

## Sync Mailbox: 單槽 + Read-Modify-Write

### Slot semantics

只有**一個 mailbox**，位址 = `hash(shared_pubkey)`。所有 paired PWA 既是 sender 也是 receiver。

- 每次寫入都是**完整 blob 覆蓋**（單槽）
- Blob 內容是 `SyncPayloadV3`（`apps/pwa/src/lib/syncMerge.ts`），所有同步欄位用 `Timestamped<T>` 包裝、機器列表配 `machineTombstones`
- 衝突解決：欄位級 LWW（已實作於 `syncMerge.ts`）

### Read-Modify-Write flow

每次本地有變更要推上去：

```
1. GET  /sync/{hash(shared_pubkey)}            ← 拉最新 blob
2. decryptSyncBlob(blob, sharedSecretKey)
3. local = mergeSyncPayloads(local, remote)    ← LWW 收斂
4. signedBlob = sign(encrypted)                ← 用共用 signing key
5. PUT  /sync/{hash(shared_pubkey)}            ← 寫回
```

LWW 是 commutative 的，兩台裝置無鎖並寫**最終仍會收斂**——但收斂前的中間狀態可能短暫缺欄位（A 寫 A 視角的 blob、B 寫 B 視角的 blob）。為避免這種抖動：

### Per-Mailbox Mutex（serialize PUT）

Relay 在 `apps/relay/src/syncStore.ts` 為單一 mailbox 維護一個簡單的 in-flight flag：

```ts
inFlight: Map<mailboxKeyHash, { sigPubkey: string; acquiredAt: number }>
```

- PUT 時若 mailbox 沒有 in-flight，標記 sender 為當前持有者，接受寫入
- PUT 時若已有 in-flight 且非同一 sender → **HTTP 409**，client 退避後重試（read-modify-write 重來一次，自然合併對方剛寫進去的內容）
- TTL：60 秒（避免 client 在 PUT 過程中崩潰造成 mailbox 永久鎖死）
- 寫入完成後立即清除 in-flight

**為何夠用（單用戶情境）**：

- 合法 sender 是使用者自己的 ~3–5 台裝置；同一個人類不會多手同時操作。並寫窗口極窄
- 真撞上 409 就退避重試，幾秒內收斂，使用者無感
- 攻擊者就算知道 mailbox 位址，沒有 `masterSecret` 仍寫不出能被解密的 blob——但他可以 PUT 垃圾占住 in-flight slot 騷擾。**這是 spam 而非 forgery**，由 per-IP rate-limit 抵擋

### 寫入授權：簽章必填

雖然 mailbox 內容是 sealed-box 加密、攻擊者無法產生有效 ciphertext，relay 仍需區分「合法 PUT」與「垃圾 PUT」以做 mutex 與 rate-limit accounting。

每次 PUT body：

```ts
interface SignedSyncEnvelope {
  ciphertext: string;       // sealed-box(encrypted SyncPayloadV3)
  sigPubkey: string;        // 共用 Ed25519 pubkey（每群唯一）
  timestamp: number;
  signature: string;        // ed25519_sign({mailboxKeyHash, ciphertext, timestamp})
}
```

Relay 驗 `signature`（純 Ed25519 verify，無狀態），失敗即 reject。這擋掉攻擊者用隨意 payload 灌爆 mutex。

`sigPubkey` 與 mailbox 一一對應（`hash(sigPubkey) ⇔ mailboxKeyHash` 透過共用 X25519 / Ed25519 同源派生關係，relay 可選擇是否驗證一致；最簡實作是只驗章不驗源）。

### Cancel（釋放 mutex）

若 client 寫入過程中決定放棄（user 取消、上層 retry），可主動釋放：

```http
DELETE /sync/{mailbox_hash}/lock
Body: { sigPubkey, timestamp, signature }
```

Relay 驗章、比對 `sigPubkey === inFlight.sigPubkey`、清除 in-flight。Cancel 是 best-effort（TTL 也會自動清）。

## Pairing Flow

新 PWA 加入既有群組的目標：把 `masterSecret` 從某台既有 PWA（B）安全送到新 PWA（A）。

### Trust anchor: QR code 物理通道

A 在本地產生 ephemeral X25519 keypair `(eA_pub, eA_sec)`，把 `eA_pub` 編成 QR 顯示在自己螢幕上。

B 用相機掃 A 螢幕上的 QR → 取得 `eA_pub`。**這個物理動作就是信任錨**：B 相信此 pubkey 屬於眼前這台裝置。

### Bootstrap blob

```ts
const blob = sealedBox(
  JSON.stringify({ masterSecret }),
  eA_pub,
);
```

B 把 `blob` 傳給 A。傳輸通道有兩種：

1. **Direct（同機房 / 同區網）**：A 同時開短期 mailbox `hash(eA_pub)` 在 relay 上監聽，B PUT blob 上去，A GET → 解密 → 寫入 secureStorage
2. **Out-of-band**：B 把 blob 編成另一個 QR 給 A 掃；完全不過 relay

第一種較順手（user 只要在 A 上開「等待配對」、在 B 上掃 QR、就完成）；第二種是 relay 不可用時的 fallback。

### A 端流程

```
1. 產生 ephemeral keypair (eA_pub, eA_sec)
2. 顯示 QR(eA_pub)，開 mailbox hash(eA_pub) 等
3. 收到 sealedBox blob
4. decryptSealedBox(blob, eA_sec) → masterSecret
5. 派生共用 X25519 / Ed25519 keypair
6. fetchMyMailbox(共用 X25519 pubkey, 共用 X25519 secret)
7. mergeSyncPayloads → 完成
8. 銷毀 ephemeral keypair 與 hash(eA_pub) mailbox
```

### Pairing 的安全性

- `eA_pub` 在 QR 上短暫顯示（建議 60 秒 TTL）。攻擊者要 MITM 必須**物理上**看到 A 螢幕並掉包 B 的相機畫面 → 不在威脅模型內
- `masterSecret` 只走 sealed-box，過 relay 也只是 ciphertext，relay / 中間人取得 blob 解不開
- 配對過程不寫共用 mailbox（避免在新成員加入前洩漏 `masterSecret` 的存在）

### 不再需要 endorsement 傳播

因為新 PWA 拿到的就是 `masterSecret` 本體，**它一旦完成 pairing 就自動屬於群組**——其他成員無需做任何「歡迎新人」的廣播。下一次任一成員 read-modify-write，新 PWA 就能以對等身分參與。

## 裝置退役與群組 Reset

### Routine retirement（裝置還在手上）

「退役一台舊平板 / 舊瀏覽器」的正確操作就是**清空該裝置的 browser storage**：`masterSecret` 與所有同步資料隨之消失，該裝置從此無法解密 mailbox。

不需要任何協定、不需要通知其他裝置、不需要更新 roster。其他裝置完全察覺不到——這是預期行為。

### Group reset（裝置遺失 / 失竊）

裝置落入第三方手中、且當事人想徹底切離 → 整群輪換 `masterSecret`。流程：

1. 任一存活的 PWA 觸發 `quicksave rotate-keys`（沿用既有 [tombstone 機制](../plans/2026-02-16-pwa-identity-and-sync-design.md)）
2. 對舊 mailbox `hash(shared_pubkey_old)` PUT tombstone（`createTombstone` in `packages/shared/src/crypto.ts`），鎖死該位址
3. 產生新 `masterSecret`，重新對其他存活 PWA 跑一次 [Pairing Flow](#pairing-flow)（每台都掃 QR）
4. **Agent 端**也輪換 pubkey：因為 agent 連線資訊存在 sync mailbox 裡，舊 mailbox 已封死後新 mailbox 是空的，需要重新從 agent 端 `quicksave pair` 一次（下個 release 可能合併到 rotate-keys 流程內）

代價明顯（所有裝置要重來），但這是低頻操作（裝置遺失才觸發），且**簡單可預測**：沒有「誰被踢掉了還能解多少歷史 blob」的曖昧區間。

## Relay Layer Protections

| 機制 | 解什麼 |
|---|---|
| Per-IP rate-limit on PUT / DELETE | 量級 DoS；burst 10/10s, sustained 60/min |
| 單槽 mailbox + per-mailbox in-flight mutex | Read-modify-write 收斂、阻擋無 `masterSecret` 的攻擊者占位騷擾（搭配 sig verify） |
| Ed25519 signature verify on PUT / DELETE | 攻擊者沒有共用 signing key 就無法消耗 mutex / rate-limit 配額之外的資源 |
| Tombstone（既有） | 群組 reset 時封死舊 mailbox |

Relay 仍**完全無狀態**（in-memory map、可隨時重啟）。重啟代價：mutex 全部釋放、in-flight 寫入需 client 重試；mailbox 內容需 paired devices 下次 push 重建。

## 與 Happy Coder 的差異

| 面向 | Quicksave | Happy |
|---|---|---|
| Identity 派生 | `masterSecret` → 共用 X25519 + Ed25519 | `secret` → 共用 Ed25519（with challenge auth） |
| Relay 架構 | Stateless；HTTP PUT/GET + mutex | Stateful；token-based auth, 持久 session |
| Sender authentication | Per-PUT Ed25519 signature（無狀態驗證） | Pre-authenticated session token（連線時驗一次） |
| Mailbox semantics | 共用單槽 + per-mailbox mutex + LWW | Per-session push 串流 |
| Pairing | QR(ephemeral pubkey) → sealed-box bootstrap | QR(ephemeral pubkey) → sealed-box bootstrap |
| 加新裝置後通知群組 | 不需要（持有 `masterSecret` 即成員） | 不需要（同上） |

核心差異是 relay 哲學：**Quicksave 堅持 stateless relay**，所有 trust 與授權由 client-side crypto 與 per-request signature 解決；Happy 接受 stateful relay 換 push 體驗。Pairing 部分兩者本質上一致。

## Files Map

| 變更 | 檔案 |
|---|---|
| 從 `masterSecret` 派生共用 X25519 + Ed25519 keypair（helper） | `packages/shared/src/crypto.ts` |
| `SignedSyncEnvelope` schema、簽 / 驗 helper | `packages/shared/src/crypto.ts`、`apps/pwa/src/lib/syncClient.ts` |
| Read-modify-write 與 409 退避邏輯 | `apps/pwa/src/lib/syncClient.ts`、`apps/pwa/src/stores/syncStore.ts` |
| Per-mailbox in-flight mutex + Ed25519 verify | `apps/relay/src/syncStore.ts`、`apps/relay/src/index.ts: handleSyncRequest` |
| Cancel route (`DELETE /sync/{hash}/lock`) | `apps/relay/src/index.ts` |
| Per-IP rate-limit middleware | `apps/relay/src/index.ts` |
| Pairing UI（顯示 QR、掃 QR、等待 mailbox、銷毀 ephemeral） | `apps/pwa/src/components/`（新檔 `PairDeviceModal.tsx`） |
| 移除：`PairedDevice` 型別、白名單持久化、endorsement 處理 | `apps/pwa/src/stores/identityStore.ts`（刪 `pairedDevices` 相關欄位） |

## Open Questions

1. **Relay 持久化**：`SyncStore` 全在記憶體，重啟即清空。對 pairing flow 是短窗口災難（QR 過期前必須完成）；steady-state sync 影響較小（下次 read-modify-write 重建）。是否需要 KV / R2 持久化？
2. **Pairing fallback**：QR + relay mailbox 流程在 relay 不可用時怎麼辦？目前傾向走 OOB QR 直送（B 端把 sealed-box 編成第二張 QR）作為手動 fallback。
3. **Agent 端 rekey 自動化**：group reset 時 agent 連線資訊也得重建，目前需手動跑 `quicksave pair`。能否在 PWA 端 `rotate-keys` 時自動產生新 invite link 給每台 agent？

## Maintenance

修改以下任一處時，**同步更新本文件**：

- `packages/shared/src/crypto.ts` 的 sign / verify / encrypt / seed-keypair 派生
- `apps/relay/src/syncStore.ts` 的 slot / mutex / in-flight 結構
- `apps/pwa/src/lib/syncClient.ts` 或 `syncMerge.ts` 的 envelope schema、read-modify-write 流程
- Pairing flow（QR 產生 / mailbox 暫存 / sealed-box bootstrap）
- Group reset / tombstone 行為
