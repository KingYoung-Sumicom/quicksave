# PWA ↔ PWA Sync Security

如何在多台 PWA client 之間安全同步「設備（agent running machines）」資訊與帳號設定。
本文件鎖定**單用戶應用**情境（每位使用者持有自己的一組裝置；relay 為跨用戶共享、無帳號狀態）。

## Threat Model

**信任邊界**：使用者持有的 PWA 裝置們互信；relay 不可信（視為 best-effort 暫存層）；外部攻擊者已知或可猜中你的 mailbox key（即 `hash(recipient pubkey)`）。

**要防的攻擊**：

| 威脅 | 說明 |
|---|---|
| Forgery | 攻擊者寫入冒充合法裝置的 sync blob，使收件方 merge 進惡意 `Machine` 條目（例如把 `agentId` 指向攻擊者持有的 pubkey），下次連線即遭 MITM |
| LWW spoof | 攻擊者把 `updatedAt` 設成極大值，讓偽造項目蓋過合法項目 |
| Mailbox spam / DoS | 外部攻擊者持續 PUT 垃圾，蓋掉合法 sender 的單槽 mailbox blob，造成同步失效 |
| Pairing impersonation | 加入新 PWA 時，攻擊者冒充使用者既有裝置回覆 bootstrap，騙新裝置接受惡意 master secret / paired devices roster |

**不在此文件範圍內**：

- Relay 程式碼本身的弱點（注入、超載防護等基礎服務治理）
- 端裝置完全淪陷後的後續攻擊（裝置上的 `secureStorage` 私鑰被竊）
- 使用者透過 phishing 主動把私鑰交出去

## Layered Design

| 層 | 機制 | 解什麼 |
|---|---|---|
| 應用層 | Sender Ed25519 簽章 + paired-devices 白名單 | Forgery、LWW spoof |
| Relay 層 | Per-IP rate-limit on PUT | 量級 DoS |
| Relay 層 | 單槽 mailbox + per-sender-key 全域 in-flight mutex | 限制單一 key 對 mailbox 命名空間的占用 |
| Relay 層 | Signed cancel request | 撤回 stale 寫入、釋放 mutex |
| 應用層 | Pairing code（OOB, 5 分鐘有效，一次性） | Pairing 階段的 bootstrap 信任錨 |

每一層只解一件事，垂直疊加；任何單一層失守不會直接導致信任鏈崩塌。

## 1. Sender Authenticity（最重要）

`encryptSyncBlob` 目前用 sealed-box（`packages/shared/src/crypto.ts:348`，每次產 ephemeral keypair 寫入），收件方解密成功**不代表寄件方身分可信**。必須在 payload 內加 sender 簽章，由收件方對照白名單驗證。

### Payload schema 變更（`SyncPayloadV3` → `V4`）

```ts
interface SignedSyncPayload {
  version: 4;
  sender: {
    pubkey: string;        // sender's X25519 pubkey (用於對應 paired device)
    signPubkey: string;    // sender's Ed25519 pubkey (用於驗章)
  };
  recipientHash: string;   // hash(recipient X25519 pubkey)，綁死 mailbox
  timestamp: number;       // sender 寫入時間，含進簽章避免 replay
  payload: SyncPayloadV3;  // 既有同步內容
  signature: string;       // ed25519_sign(canonicalize({sender, recipientHash, timestamp, payload}))
}
```

**`recipientHash` 必填**：避免攻擊者把 mailbox A 的合法 blob 重放到 mailbox B。
**`timestamp` 含進簽章**：攻擊者無法調整時間繞過時效檢查。

### 收件端驗證流程（`apps/pwa/src/lib/syncClient.ts: fetchMyMailbox`）

1. 解密 outer envelope（sealed-box，現行邏輯）
2. 解析 `SignedSyncPayload`，檢查 `recipientHash === hash(myPublicKey)` → 不符直接 drop
3. 檢查 `sender.pubkey ∈ pairedDevices`（已配對裝置白名單）→ 不在直接 drop（**silent**，不提示 user，避免讓攻擊者用 dialogs 騷擾）
4. 用 `sender.signPubkey` 驗 `signature` → 失敗直接 drop
5. 通過後才進 `syncMerge` LWW 合併

### `pairedDevices` 結構

```ts
interface PairedDevice {
  pubkey: string;          // X25519 (encryption)
  signPubkey: string;      // Ed25519 (signature verification)
  nickname: string;
  pairedAt: number;
  pairingMethod: 'qr' | 'code';  // 為了 audit
}
```

存放於 `apps/pwa/src/stores/identityStore.ts`（已有 `quicksave-paired-devices` localStorage key）。Schema 升級需 migration。

## 2. Mailbox Model: 單槽 + Per-Key Mutex

### Slot semantics

每個 recipient mailbox（key = `hash(recipient pubkey)`）保留**單槽**設計（與現行一致）。Relay 額外維護：

```ts
// apps/relay/src/syncStore.ts
inFlightSlots: Map<senderPubkeyHash, recipientMailboxKey>
```

- 一個 sender pubkey 在任一時刻**只能在一個 mailbox 持有未消費的 slot**
- PUT 時 relay 檢查 sender 是否已有 outstanding slot：
  - 寫入同一 mailbox（覆蓋自己的 slot）→ 允許
  - 寫入不同 mailbox → **拒絕（HTTP 409）**，sender 必須先 cancel 或等到原 slot 被消費 / TTL 過期
- TTL：建議 1 小時（夠長到讓收件方有時間上線拉取，夠短到不會永久占位）

**為何這樣設計（單用戶情境）**：
- 合法 sender 是使用者自己的 ~3–5 台裝置，一次 fan-out 序列化執行（寫 A → 等消費 → 寫 B）→ 完整 convergence 約數十秒到數分鐘，state sync 不是延遲敏感的
- 一台裝置不可能同時被人手動操作（人類只有兩手）→ 合法 sender 之間不會競爭同一個 slot
- 攻擊者就算在 paired-devices 簽章驗證之外灌垃圾，per-key mutex 也只允許他占據單一 mailbox slot；想騷擾多個 mailbox 必須持續 cancel + rotate，配合 per-IP rate-limit 性價比極差

### Slot 釋放條件

| 觸發 | 動作 |
|---|---|
| 收件方 GET 成功 | Slot 自動清除（mailbox 視為「letter taken」） |
| Sender 主動 cancel | Slot 清除（見下） |
| TTL 到期（1 小時） | Relay 後台清除 |

### Cancel

Sender 簽 `{action: "cancel", mailbox_hash, timestamp}` 用自己的 Ed25519 私鑰。Relay 比對 slot 上記錄的 `senderPubkeyHash`，驗章後清除。

```http
DELETE /sync/{mailbox_hash}
Body: { senderPubkey, timestamp, signature }
```

Cancel 是 best-effort：若收件方已 GET 過，撤回對對方狀態無效，文件需明示。

## 3. Per-IP Rate-Limit

Relay 對 `PUT /sync/*` 與 `DELETE /sync/*`（cancel）做 per-source-IP 限流：

- Burst：10 requests / 10 seconds
- Sustained：60 requests / minute

實作建議走 token bucket，state 存記憶體即可（relay 重啟 reset 不影響安全性）。Reverse-proxy（Cloudflare、Caddy）若已有限流，這層可以薄一些。

## 4. Pairing Bootstrap

新加入的 PWA 沒有任何 `pairedDevices`，需要從**既有的某台裝置 B** 取得：
1. B 的 `signPubkey`（之後驗章用）
2. 群組裡所有其他裝置的 `signPubkey`（讓新裝置認識整群）
3. `masterSecret` / `apiKey` 等同步 payload 內容

### Pairing code 流程

1. **B**（既有裝置）開「加入新裝置」→ 顯示 6 位數字 code（或 QR），有效 5 分鐘
2. **A**（新 PWA）輸入 code（或掃 QR）
3. A 在本地產生 X25519 + Ed25519 keypair，組 `Request = sign_A({A.pubkey, A.signPubkey, timestamp, salt, hash(code)})`
4. A `PUT /pair-requests/{hash(code)}`（relay 上的暫存槽，5 分鐘 TTL，per-code 單槽）
5. B 輪詢或 ws-watch `/pair-requests/{hash(code)}`，撈到唯一一筆 → 驗 A inner signature → 顯示「已配對 nickname?」讓 user 確認 nickname（**不顯示 pubkey 給 user 比對**）
6. B 簽 `Endorsement = sign_B({A.pubkey, A.signPubkey, timestamp})`，併入下一輪 sync payload 廣播給其他 paired devices
7. B 同時回寫 A 的 mailbox：`{master secret, paired devices roster, signed by B, MAC'd with hash(code)}`
   - A 用 `hash(code)` 當 HMAC key 驗 MAC（只有看到 code 的 B 算得出）→ 信任這份 bootstrap → 之後就用簽章驗其他成員
8. A 把 B 加入 `pairedDevices`，根據 roster 把其他成員也加入

其他成員下一次拉到含 `Endorsement` 的 sync blob 時，驗 B 的簽章 → 自動把 A 加入自己的 `pairedDevices`。群組自然收斂。

### Code 性質

- 6 位 base32（≈30 bits 熵）+ 5 分鐘有效 + 一次性消耗 → 線下口傳 / SMS 強度足夠
- 也可改用 QR：QR payload = `code:URI://...`，掃了等於輸入 code，多一個物理通道
- **嚴禁顯示 pubkey 讓 user 自己比對**——已知 UX 失敗模式

### Revocation

| 場景 | 動作 |
|---|---|
| 誤配對 / code 外流 | B 在 code 有效期內可手動 revoke（PUT 一個 revoke marker 到 `/pair-requests/{hash(code)}`） |
| 想踢掉某台裝置 | 任一 paired device 簽 `Removal = sign_X({remove: target.pubkey, timestamp})` 併入 sync payload；其他成員看到後從自己的 `pairedDevices` 移除 |

裝置移除無法強制——被踢的裝置仍持有自己的 keypair 與 master secret。實務上要搭配 `masterSecret` 輪換才能真正切離（見「Open Questions」）。

## Files Map

| 變更 | 檔案 |
|---|---|
| 新 payload schema `V4` 與 sign/verify helper | `packages/shared/src/crypto.ts`、`apps/pwa/src/lib/syncMerge.ts` |
| 收件端驗章 + 白名單過濾 | `apps/pwa/src/lib/syncClient.ts: fetchMyMailbox` |
| `PairedDevice` 型別擴充與 migration | `apps/pwa/src/stores/identityStore.ts` |
| Per-key in-flight mutex | `apps/relay/src/syncStore.ts` |
| Cancel route | `apps/relay/src/index.ts: handleSyncRequest`（新增 DELETE 分支） |
| Per-IP rate-limit middleware | `apps/relay/src/index.ts` |
| Pairing code routes (`/pair-requests/*`) | `apps/relay/src/index.ts`（新檔 `pairRoutes.ts`） |
| Pairing UI（顯示 code、輸入 code、確認 nickname） | `apps/pwa/src/components/`（新檔 `PairDeviceModal.tsx` 等） |

## Open Questions

1. **`masterSecret` 輪換**：踢掉裝置後是否輪換 master secret？輪換代價（所有裝置都要更新、歷史 sync blob 失效）vs. 不輪換（被踢裝置仍能解出歷史，但無法接收新 sync）。
2. **Relay 持久化**：目前 `SyncStore` 全在記憶體，relay 重啟即清空。對 pairing 流程而言這是個短窗口的災難；對 steady-state sync 影響較小（下次寫入會重建）。是否需要 KV / R2 持久化？
3. **Bootstrap 失敗復原**：A 輸入 code 後 B 端離線，A 永遠拿不到 endorsement。是否需要在 A 端加 timeout + retry / 切換到 QR fallback？
4. **多 relay / 自架 relay**：目前架設假設單一 relay；若使用者自架，pairing flow 跨 relay 行不行？建議第一版只支援同 relay。

## Maintenance

修改以下任一處時，**同步更新本文件**：

- `packages/shared/src/crypto.ts` 中的 sign / verify / encrypt 函式
- `apps/relay/src/syncStore.ts` 的 slot 結構或 mutex 邏輯
- `apps/pwa/src/lib/syncClient.ts` / `syncMerge.ts` 的 payload schema 或合併邏輯
- `apps/pwa/src/stores/identityStore.ts` 的 `PairedDevice` 結構
- 新增的 pairing 流程或 revocation 機制
