# iOS Keyboard Layout Fix

## Background

iOS Safari PWA 開鍵盤時有多個互相干擾的行為，需要多層 workaround 才能讓 layout 正確。

---

## 問題清單與原因

### 1. App bar 被推出畫面

iOS 開鍵盤時，瀏覽器會自動 scroll layout viewport 讓 focused input 進入視野。
這個 scroll 會把整個頁面往上推，app bar 消失在上方。

### 2. 鍵盤開啟後高度不縮

`interactive-widget=resizes-content` 在 iOS 上被完全忽略（iOS 只支援 `resizes-visual`）。
`100dvh` 在 iOS 16+ 確實跟 visual viewport 綁定，但 layout viewport 不縮，
導致 `height: 100%` 繼承鏈抓到的是錯誤的高度。

### 3. `safe-area-inset-bottom` 不隨鍵盤改變

iOS 的 `safe-area-inset-bottom`（home indicator 間距，通常 34–46px）
鍵盤開啟時不歸零，導致 input bar 下方多出一段空白。

### 4. Body 層級的 bounce scroll

即使 `#root` 高度正確、`overflow: hidden`，
iOS 仍然允許使用者在沒有 overflow 的區域拖動並觸發 body scroll。

---

## 解法

### A. `#root` 用 `position: fixed` + `visualViewport.height`

```css
/* index.css */
#root {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: var(--vv-height, 100dvh);
  overflow: hidden;
}
```

```ts
// App.tsx — 追蹤 visualViewport.height 寫入 CSS variable
const vv = window.visualViewport;
const update = () => {
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vv-height', `${h}px`);
  document.documentElement.style.height = `${h}px`;
  document.body.style.height = `${h}px`;
};
vv?.addEventListener('resize', update);
update();
```

- `position: fixed` 讓 `#root` 脫離文件流，iOS 無法 scroll 它，app bar 不消失
- `visualViewport.height` 是唯一在 iOS 上隨鍵盤正確縮小的值

### B. Layout viewport scroll reset

iOS 開鍵盤時仍然會 scroll layout viewport（即使 `#root` 是 fixed），
需要在 `visualViewport` 的 `scroll` 事件立刻打回去：

```ts
// App.tsx
vv.addEventListener('scroll', () => window.scrollTo(0, 0));
```

### C. `safe-area-inset-bottom` 用 `:focus-visible` 抑制

純 CSS，不需要 JS：

```css
/* index.css */
.safe-area-bottom-input {
  padding-bottom: 0.75rem;
  :root:not(:has(input:focus-visible, textarea:focus-visible, [contenteditable]:focus-visible)) & {
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.75rem);
  }
}
```

鍵盤開啟時 textarea 有 `:focus-visible`，safe-area padding 被抑制。
鍵盤收起後 `:focus-visible` 消失，padding 恢復。

### D. `touch-none` 防止 body bounce scroll

在不應該觸發 scroll 的 UI 區域加上 `touch-action: none`（Tailwind: `touch-none`）：

- StatusBar (`header`)
- Input bar (`div.safe-area-bottom-input`)

聊天訊息區加上 `overscroll-contain` 防止 scroll 往上傳給 body。

---

## 最終 file 變動摘要

| File | 變動 |
|------|------|
| `index.html` | 移除 `interactive-widget=resizes-content`（iOS 無效） |
| `index.css` | `#root` 用 `position: fixed` + `var(--vv-height)`；`html/body` 用 `height: 100%` + `overflow: hidden`；`.safe-area-bottom-input` 用 `:focus-visible` 條件 |
| `App.tsx` | 追蹤 `visualViewport.height` → CSS variable；`scroll` event reset；body bounce touchmove 攔截 |
| `ClaudePanel.tsx` | 聊天容器加 `overscroll-contain`；input bar 加 `touch-none` |
| `StatusBar.tsx` | header 加 `touch-none` |

---

## 為什麼這麼髒

iOS Safari 對 PWA 的 keyboard handling 設計跟 native app 不同，
且多個相關標準（`interactive-widget`、`safe-area-inset-bottom` 動態更新）在 iOS 上都未實作或行為不符規範。
這些 workaround 是目前唯一可靠的方法，直到 Apple 修好這些問題為止。
