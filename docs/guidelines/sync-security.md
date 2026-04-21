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

新 PWA 加入既有群組的目標：把 `masterSecret` 從某台既有 PWA（A）安全送到新 PWA（B）。
**角色約定**（本節起固定）：
- **A** = 既有 group member，握有 `masterSecret`，由使用者在 UI 上「確認要加入這台新裝置」
- **B** = joiner，無任何群組狀態，只有本地 ephemeral keypair

### 設計要點

兩個認證通道疊加、各司其職：

- **第一通道（A → B，pubkey 傳遞）**：A 產生 ephemeral keypair `(eA_pub, eA_sec)`，把 `eA_pub` 同時用 **QR code 與 deep-link URL** 兩種形式呈現（見 [Pubkey 傳遞通道](#pubkey-傳遞通道)）。使用者二選一，都 → 物理/通道層面證明「B 拿到的 pubkey 屬於這次由 A 發起的配對」，同時得到 mailbox 位址 `hash(eA_pub)`（非全域可見）與加密公鑰
- **SAS 通道（B → A，肉眼）**：B 螢幕顯示 `SAS = sasEncode(HMAC(eB_pub ‖ bucket(now, 60s)), 6)`。A 手動輸入 → 對 A **從 mailbox 收到的若干候選 pubkey** 獨立算 SAS 逐一比對，找出唯一符合的那顆
- **多槽 mailbox + TTL**：`hash(eA_pub)` 的信箱**不是單槽覆蓋**而是**append-only 多槽**，每槽獨立 TTL（5 分鐘）。攻擊者的 inject 會變成信箱裡的一條雜訊而非覆蓋合法 B 的提交；SAS 過濾把雜訊丟掉。信箱到壽自動銷毀
- **SAS 不是加密金鑰，是肉眼驗證值**：從公開資料算出不是缺陷——它不防竊聽，只防 pubkey substitution

### Pubkey 傳遞通道

A 在「加入新裝置」UI 同時提供兩種形式，使用者依手邊裝置選其一：

```
URL 格式（deep link）：
  https://pwa.quicksave.dev/pair#k=<base64url(eA_pub)>

QR 格式：
  QR code 編碼上述同一個 URL 字串（B 掃 QR 等同打開 URL）
```

**為何 `eA_pub` 放在 fragment（`#` 之後）而非 query（`?`）**：

fragment 不會被瀏覽器送到 server，也不會進 HTTP request log、CDN log、或 referer header。PWA 前端 JS 讀 `location.hash` 解出 `eA_pub` 本地處理。這對 relay 是誠實的「不知道也看不到」。用 query string 則 relay 的 TLS 終端可能留下紀錄。

**QR 與 URL 是否等價？**

安全語義等價：兩者都只傳 `eA_pub`（公開資料）。差別在**洩漏管道**：

| 通道 | 典型暴露面 | 對 pairing 安全的影響 |
|---|---|---|
| QR 顯示在 A 螢幕 | 肩窺、遠距相機 | 攻擊者仍需撞 SAS 才能騙 A；見 [安全性分析](#安全性分析) |
| URL 手動複製 / 分享 | 剪貼簿、聊天室、瀏覽器歷史、截圖同步 | 同上——拿到 URL = 拿到 `eA_pub`，能 inject 但擋不過 SAS 過濾 |

換句話說 URL 通道**沒有額外削弱 SAS 保證**；只是讓攻擊者拿到 `eA_pub` 的機會從「物理在場」擴大到「能看到使用者的剪貼簿或聊天訊息」。SAS 那層仍然是最終閘門。

**UX 分工**：

- 手機 → 手機 / 手機 → 桌機：用 QR（相機自然）
- 桌機 → 手機：掃 QR 或點 URL 都可
- 桌機 → 桌機、或相機不便：點 URL / 複製連結（B 端直接 paste 進瀏覽器或 PWA 的「加入裝置」欄）
- 跨網路分享（極少數情境，不建議但技術上可）：把 URL 丟給另一台裝置上的自己。5 分鐘 TTL 內要完成整個流程

### SAS 編碼與位數

```ts
// packages/shared/src/crypto.ts
const SAS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  // 32 個、移除 0/1/I/O、不分大小寫
function sasEncode(hmacOutput: Uint8Array, chars: number): string {
  // 取 hmacOutput 前 chars*5 bits，每 5 bits 查表
}
```

**定案：6 碼、32 符號 alphabet、共 30 bits**。

#### 判斷理由

6 碼空間 = 32⁶ ≈ 10.7 億。典型攻擊情境下的實際機率：

| 情境 | 攻擊者能力 | 單次配對被攻破機率 |
|---|---|---|
| **A：正常威脅模型** | 看得到 relay 流量；**看不到** B 螢幕 | **1 / 16.8M**（盲射 64 槽上限，每槽獨立 1/32⁶） |
| **B：偏執情境** | 同時物理看到 A QR + B 螢幕 + 有 GPU 資源（暴力找撞碼 pubkey） | 6 碼：~1/bucket；8 碼：~10⁻³；10 碼：~10⁻⁶ |

**情境 A 選 6 碼的理由**：

- 1/16.8M 比搭飛機遇到墜機（1/11M）稀有、比中 Powerball 頭獎（1/292M）容易，落在「比災難稀有、比中樂透平庸」這個讓人直覺安心的區間
- 6 碼在人類短期記憶容量（7±2）以內，掃完 B 一眼記住直接打到 A，不用在兩台螢幕間跳視線
- SAS 只活在配對當下的 60s bucket 裡，不存任何地方；就算撞碼的攻擊者 POST 成功，也只有那個 session 受影響，不是帳號等級的永久失守

**為何不升到 8 碼、10 碼以覆蓋情境 B**：

情境 B 的前提是「攻擊者能遠端即時看到 B 的螢幕畫面」。能做到這件事通常意味著：
1. 在 B 上裝了 malware / 遠端桌面控制 → **攻擊者已經拿到 B 的完整權限**，能直接拿 IndexedDB 裡的 `masterSecret`、竊取 session token、讀訊息，根本不需要繞 SAS
2. 在物理上能看到 B 的螢幕（身後偷瞄、穿牆相機）→ 這種場景下攻擊者多半**也能直接操作 B**，同樣不需要繞 SAS

換句話說，**一個能看到 B 螢幕的攻擊者幾乎必然有比 SAS 撞碼更快的攻擊路徑**。用 8–10 碼去防一個實際上已經淪陷的端點，代價是每次配對都得輸入更長的隨機字串——換不到有意義的額外安全性，只換到 UX 惡化。

若未來出現明確的「只能看螢幕、拿不到資料」的威脅類別（公共顯示、投影配對等），可把 SAS 長度做成可調，不影響核心 protocol。

### 流程

```
A = existing (has masterSecret)
B = joiner  (fresh)

【Phase 1. A 開 ephemeral mailbox】
  1. A UI「加入新裝置」→ 產生 ephemeral (eA_pub, eA_sec)
  2. A 組 pair_url = https://pwa.quicksave.dev/pair#k=<base64url(eA_pub)>
     A 同時顯示 QR(pair_url) 與可複製的 pair_url 文字
     A 訂閱 pubsub topic hash(eA_pub)
  3. Relay 預設 mailbox TTL = 5 分鐘，到期自毀

【Phase 2. B 透過 QR 或 URL 收到 eA_pub】
  4. 使用者在 B 上二擇一：
     (a) 用相機掃 A 螢幕的 QR → 自動打開 pair_url，B PWA 從 location.hash 解出 eA_pub
     (b) 把 pair_url 貼進 B 的瀏覽器 / PWA「加入裝置」欄位 → 同上
  5. B 產生 ephemeral (eB_pub, eB_sec)
  6. B 組 slot = sealed_box(JSON.stringify({ eB_pub, ts }), eA_pub)
  7. B POST /pair-requests/hash(eA_pub) { slot }
     ＊ Relay append 到該信箱的槽陣列，回傳 slot_id
  8. B 螢幕顯示 SAS = sasEncode(HMAC(eB_pub ‖ bucket(now, 60s)), 6)
     Bucket 60s；每 30s 刷新一次以容忍輸入延遲

【Phase 3. A 收候選 → 輸入 SAS → 過濾】
  9. A pubsub 收到新 slot 事件 → 讀取 /pair-requests/hash(eA_pub)
  10. A 用 eA_sec 對每個 slot 做 decryptSealedBox，得候選列表
      candidates = [{ eB_pub_i, ts_i }, ...]
      攻擊者若有插槽，會被解密但是亂碼（sealed_box 以 eA_pub 加密、他沒 eA_sec）
      → 解密成功的才留下（已篩掉未知源頭）
  11. A UI「請輸入新裝置螢幕上的 8 碼」
  12. 使用者輸入 SAS
  13. A 對每個候選算 expected_i = sasEncode(HMAC(eB_pub_i ‖ bucket(now ±1, 60s)), 6)
      matched = candidates.filter(c => expected_i == typed_SAS)
  14. matched.length:
        0 → UI「沒有對上的裝置，請確認 code」(允許重試)
        1 → 採用該 eB_pub，進 Phase 4
        2+ → UI 紅色警示「偵測到可疑碰撞，配對中止」，DELETE mailbox

【Phase 4. 傳 masterSecret】
  15. A 組 blob = sealed_box(JSON.stringify({ masterSecret }), matched.eB_pub)
  16. A POST /pair-requests/hash(eA_pub) { blob, kind: 'secret' }
      （新的 slot，B 用 slot.kind 過濾）
  17. B polling → 抓到 kind='secret' 的 slot
  18. B decryptSealedBox(blob, eB_sec) → masterSecret
  19. B 派生共用 X25519 + Ed25519 keypair，寫入 secureStorage
  20. B fetchMyMailbox → mergeSyncPayloads → 完成

【Phase 5. 銷毀】
  21. A DELETE /pair-requests/hash(eA_pub)（主動）
  22. 或 TTL 到期 relay 自動清除
  23. 雙方銷毀 ephemeral keypair
```

### Multi-slot mailbox schema（relay 側）

```ts
// apps/relay/src/pairStore.ts
interface PairSlot {
  id: string;              // relay-assigned
  data: string;            // sealed_box ciphertext (anonymous)
  kind?: string;           // optional tag for client filtering
  createdAt: number;
}

interface PairMailbox {
  addr: string;            // hash(eA_pub)
  slots: PairSlot[];       // append-only, cap 64
  expiresAt: number;       // createdAt + 5min
}
```

- POST 只能 append（不能覆蓋既有 slot）
- GET 回整個 slots array（client 端 decrypt + filter）
- 每個 mailbox 硬上限 64 槽，超過拒收（防 DoS 灌爆）
- Mailbox 本身 TTL 5 分鐘；整個結構到期直接 drop

### 安全性分析

| 攻擊 | 防線 |
|---|---|
| 被動觀察 relay 流量 | `masterSecret` 與 `eB_pub` 都走 sealed_box（以 `eA_pub` 加密），攻擊者看得到 ciphertext 但解不開 |
| 攻擊者不在 A 面前、想從 relay 找配對中的信箱 | Mailbox 位址 = `hash(eA_pub)`；不看 QR 算不出位址（256-bit 熵） |
| 攻擊者看到 QR（肩窺 / 遠距相機）或攔截 URL（剪貼簿 / 聊天室 / 歷史紀錄） | 能 POST 自己的 slot，但其 pubkey 的 SAS 與 B 螢幕顯示不符 → 被 A 端過濾丟棄。QR 與 URL 在此層面等價 |
| 攻擊者暴力搜尋一個 pubkey 讓其 SAS 撞碼 | 6 碼 32 符號 SAS = 30 bits ≈ 10.7 億空間。正常威脅下（看不到 B 螢幕）攻擊者只能盲射，64 槽上限下單次配對失守機率 1/16.8M（比 Powerball 頭獎稀有 17 倍）。見 [SAS 編碼與位數](#sas-編碼與位數) 詳述 |
| 多個候選都過 SAS | 視為攻擊，中止配對並清信箱——正常流程下不會有兩顆合法 pubkey |
| Relay 偽造或重排 slots | Relay 可以，但偽造的 slot 解不開（sealed_box 需 eA_sec）；重排不影響 SAS 過濾 |
| DoS 灌爆 mailbox | Per-mailbox 硬上限 64 slot + TTL 5 分鐘 + per-IP rate-limit |

### 不再需要 endorsement 傳播

因為新 PWA 拿到的就是 `masterSecret` 本體，**它一旦完成 pairing 就自動屬於群組**——其他成員無需做任何「歡迎新人」的廣播。下一次任一成員 read-modify-write，新 PWA 就能以對等身分參與。

## Agent 端信任模型

Quicksave 的 agent 不是 PWA 群組的 peer，而是**受控端**：它不持有 `masterSecret`，只持有自己本地產生的 X25519 + Ed25519 keypair，並認一把 PWA 群組的共用 pubkey 當 upstream 信任錨。這與 Happy 的「agent 也存 root secret」是本質上的差異——我們的 agent 淪陷不等於群組淪陷。

### TOFU（Trust On First Use）

Agent 現行實作（`apps/agent/src/connection/connection.ts`）**不持久化 peer pubkey**，只在 session 期間 in-memory 持有 DEK。新設計：

1. 使用者在 agent host 跑 `quicksave pair` → agent 進入 pairing 模式，廣告自己的 pubkey（既有的 invite flow）
2. 第一台成功完成 V2 handshake 的 PWA client 被視為 upstream 信任錨
3. Agent 將該 client 出示的 **共用 X25519 pubkey + 共用 Ed25519 signing pubkey** 寫入 agent config（`~/.quicksave/config.json`）
4. 日後任何 handshake 必須提出能用**相同 signing pubkey** 驗過的 challenge-response；不符即拒絕（而非像現在接受任何能完成 V2 的 peer）

**為何 TOFU 夠**：agent 的 `quicksave pair` 是使用者在 agent host 本地主動觸發的——使用者自己知道此刻 pairing mode 打開了，第一個連進來的就是目標 PWA 群組。與 SSH 的 known_hosts 同性質。

### Tombstone Pubsub 訂閱

Agent 在與 relay 連線時（既有 pubsub 通道），額外訂閱：

```
tombstone:{hash(stored_PWA_X25519_pubkey)}
```

- 當 PWA 群組跑 `rotate-keys` 時，既有的 tombstone 流程會 PUT 到舊 mailbox；relay 偵測到 tombstone 寫入後，推一則 `{ type: 'tombstone', signature, ... }` 事件到此 topic
- Agent 收到後：
  1. 用 stored signing pubkey 驗 tombstone 簽章（`createTombstone` / `verifyTombstone` 已存在於 `packages/shared/src/crypto.ts`）
  2. 驗章通過 → 清除本地 stored PWA pubkey、清除自己的 agent keypair、清除所有 session state
  3. 進入**「自閉模式」**（closed/unpaired）：關閉 relay 連線、拒絕所有入站 handshake；本地僅接受 `quicksave pair` 這一個 CLI 指令
- 驗章不過 → 丟棄事件（防 relay 偽造 tombstone 觸發 agent 自毀 DoS）

### 自閉模式脫離

使用者在 agent host 跑 `quicksave pair` → agent 產生新 keypair、廣告 invite、等待新 PWA 群組的第一次 handshake（TOFU 重新開始）。沒有其他脫離路徑。

### 為何不用 polling

既有 pubsub 通道 agent 已經 connected；多訂一個 topic 成本趨近於零，latency 也比定時 poll `/sync/{hash}` 好很多。Relay 重啟後 pubsub 重連時 agent 會重新訂閱；重啟期間若有 tombstone 推送遺失，agent 下次 handshake 時可以對 PWA 出示「stored signing pubkey 的當前 validity 查詢」作為補救（未來擴充，第一版不含）。

## 裝置退役與群組 Reset

### Routine retirement（裝置還在手上）

「退役一台舊平板 / 舊瀏覽器」的正確操作就是**清空該裝置的 browser storage**：`masterSecret` 與所有同步資料隨之消失，該裝置從此無法解密 mailbox。

不需要任何協定、不需要通知其他裝置、不需要更新 roster。其他裝置完全察覺不到——這是預期行為。

### Group reset（裝置遺失 / 失竊）

裝置落入第三方手中、且當事人想徹底切離 → 整群輪換 `masterSecret`。流程：

1. 任一存活的 PWA 觸發 `quicksave rotate-keys`（沿用既有 [tombstone 機制](../plans/2026-02-16-pwa-identity-and-sync-design.md)）
2. 對舊 mailbox `hash(shared_pubkey_old)` PUT tombstone（`createTombstone` in `packages/shared/src/crypto.ts`），鎖死該位址
3. Relay 將 tombstone 透過 pubsub topic `tombstone:{hash(shared_pubkey_old)}` 推送。**所有訂閱的 agent 驗章後自動進入自閉模式**（見 [Agent 端信任模型](#agent-端信任模型)）
4. 產生新 `masterSecret`，重新對其他存活 PWA 跑一次 [Pairing Flow](#pairing-flow)
5. 對每一台 agent 跑一次 `quicksave pair`（agent 端 CLI），重建 TOFU 信任錨

代價明顯（所有 agent 要再 pair 一次），但這是低頻操作（裝置遺失才觸發），且**簡單可預測**：沒有「誰被踢掉了還能解多少歷史 blob」的曖昧區間。關鍵優點是 agent 的自毀是**自動**的——不會出現「PWA 群已 rotate 但 agent 還信舊 key」的殘留信任窗口。

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
| PWA pairing | QR(ephemeral pubkey) + 多槽 mailbox + SAS 過濾 → sealed-box bootstrap | QR(ephemeral pubkey) → sealed-box bootstrap |
| Agent 存什麼 | 自己的 keypair + **stored PWA pubkey**（TOFU，不持 `masterSecret`） | 完整 `secret`（與 phone 對等身分） |
| Agent 在 rotate 時 | 自動 self-destruct（訂閱 tombstone topic） | 不支援；使用者手動重 pair |
| 加新裝置後通知群組 | 不需要（持有 `masterSecret` 即成員） | 不需要（同上） |

核心差異有兩處：
1. **Relay 哲學**：Quicksave 堅持 stateless relay；Happy 接受 stateful relay 換 push 體驗。
2. **Agent 信任模型**：Quicksave agent 不持 `masterSecret`、只透過 TOFU 記一把 PWA pubkey；agent 淪陷 ≠ 群組淪陷。Happy agent 持完整 secret，agent 淪陷 = 完整帳號淪陷。這是我們相對 Happy 做出的實質安全性改進。

## Files Map

**Sync mailbox（穩態）**

| 變更 | 檔案 |
|---|---|
| 從 `masterSecret` 派生共用 X25519 + Ed25519 keypair（helper） | `packages/shared/src/crypto.ts` |
| `SignedSyncEnvelope` schema、簽 / 驗 helper | `packages/shared/src/crypto.ts`、`apps/pwa/src/lib/syncClient.ts` |
| Read-modify-write 與 409 退避邏輯 | `apps/pwa/src/lib/syncClient.ts`、`apps/pwa/src/stores/syncStore.ts` |
| Per-mailbox in-flight mutex + Ed25519 verify | `apps/relay/src/syncStore.ts`、`apps/relay/src/index.ts: handleSyncRequest` |
| Cancel route (`DELETE /sync/{hash}/lock`) | `apps/relay/src/index.ts` |
| Per-IP rate-limit middleware | `apps/relay/src/index.ts` |
| 移除：`PairedDevice` 型別、白名單持久化、endorsement 處理 | `apps/pwa/src/stores/identityStore.ts`（刪 `pairedDevices` 相關欄位） |

**PWA pairing（QR + SAS + 多槽 mailbox）**

| 變更 | 檔案 |
|---|---|
| `/pair-requests/{hash(eA_pub)}` routes（POST append / GET all / DELETE） | `apps/relay/src/index.ts`、新檔 `apps/relay/src/pairStore.ts` |
| Multi-slot mailbox 結構（append-only, cap 64, TTL 5min） | `apps/relay/src/pairStore.ts` |
| SAS helper（`sasEncode(HMAC(pubkey‖bucket), 6)`、32 符號 alphabet、±1 bucket verify） | `packages/shared/src/crypto.ts` |
| Ephemeral keypair 產生 + pair URL 組裝 + QR 編碼 + 訂閱 pubsub + slot 解密 / SAS 過濾 | `apps/pwa/src/lib/pairClient.ts`（新檔） |
| `/pair#k=<eA_pub>` 路由、從 `location.hash` 解析 `eA_pub`、deep-link handler | `apps/pwa/src/routes/pair.tsx`（新路由）、PWA manifest `url_handlers` |
| Pairing UI（A 側：QR + 可複製 URL + 輸入 SAS；B 側：掃 QR 或 paste URL + 顯示 SAS） | `apps/pwa/src/components/`（新檔 `PairDeviceModal.tsx`、`JoinGroupModal.tsx`） |

**Agent 信任（TOFU + 自毀）**

| 變更 | 檔案 |
|---|---|
| Agent config 增加 `peerPWAPublicKey` / `peerPWASignPublicKey` 欄位 | `apps/agent/src/config.ts` |
| Handshake 強制驗 peer 簽章比對 stored pubkey | `apps/agent/src/connection/connection.ts: handleKeyExchange` |
| Tombstone pubsub topic 訂閱 + 驗章 + self-destruct | `apps/agent/src/connection/connection.ts`、`packages/shared/src/crypto.ts: verifyTombstone` |
| 「自閉模式」狀態機 + CLI 解鎖路徑 | `apps/agent/src/state.ts`（新狀態）、`apps/agent/src/cli/pair.ts` |
| Relay 對 tombstone 寫入時向 pubsub 推送 | `apps/relay/src/syncStore.ts`、`apps/relay/src/index.ts` |

## Open Questions

1. **Relay 持久化**：`SyncStore` 全在記憶體，重啟即清空。對 pairing flow 是短窗口災難（mailbox 5 分鐘 TTL 內 relay 若重啟，使用者需從頭掃 QR）；steady-state sync 影響較小（下次 read-modify-write 重建）。是否需要 KV / R2 持久化？
2. **Relay tombstone pubsub 可靠性**：agent 若在 tombstone 推送瞬間離線，重連時如何補救？第一版接受「重連時向 relay 查詢目前 mailbox 狀態」作為 catch-up；需要 relay 提供 `GET /sync/{hash}?include-tombstone` 類介面。
3. **Agent 自動 re-pair**：group reset 後每台 agent 都要手動 CLI `quicksave pair`，規模大時很煩。能否讓 agent 在自毀後印出 invite URL 到 stdout / log，讓 PWA 端掃一下就完成？第一版保守走純手動。
4. **SAS 位數可調**：預設 6 碼 / 30 bits 已涵蓋正常威脅模型（見 [SAS 編碼與位數](#sas-編碼與位數)）。若未來出現「攻擊者能看螢幕但拿不到資料」的特殊場景（投影配對、公共看板等），可把 `sasEncode` 的 length 參數做成設定值，不改 protocol。
5. **Pair URL handling in PWA installs**：deep link `https://pwa.quicksave.dev/pair#k=...` 在已安裝 PWA 的裝置上能否直接喚起 PWA？要看瀏覽器對 `url_handlers` 的支援程度（Chrome 有、Safari 較弱）。退路：未安裝 PWA 時瀏覽器直接打開網頁版 pair flow。

## Maintenance

修改以下任一處時，**同步更新本文件**：

- `packages/shared/src/crypto.ts` 的 sign / verify / encrypt / seed-keypair / SAS 派生
- `apps/relay/src/syncStore.ts` 的 slot / mutex / in-flight 結構
- `apps/relay/src/pairStore.ts` 的 `/pair-requests/*` 生命週期
- `apps/pwa/src/lib/syncClient.ts` 或 `syncMerge.ts` 的 envelope schema、read-modify-write 流程
- `apps/pwa/src/lib/pairClient.ts` 的 pairing flow（T 產生、SAS 計算、pubsub 訂閱）
- `apps/agent/src/config.ts` 的 `peerPWA*` 欄位
- `apps/agent/src/connection/connection.ts` 的 handshake 驗 pubkey 流程
- Agent 自閉模式狀態機與 tombstone pubsub 訂閱邏輯
- Group reset / tombstone 行為（含 relay 推送到 pubsub）
