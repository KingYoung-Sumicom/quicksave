# iOS Keyboard Layout Fix

## Background

iOS Safari PWA has multiple interfering behaviors when the keyboard opens, requiring several layers of workarounds to get the layout right.

---

## Problem list and root causes

### 1. App bar gets pushed off screen

When iOS opens the keyboard, the browser automatically scrolls the layout viewport to bring the focused input into view.
This scroll pushes the entire page upward, and the app bar disappears off the top.

### 2. Height does not shrink after the keyboard opens

`interactive-widget=resizes-content` is completely ignored on iOS (iOS only supports `resizes-visual`).
`100dvh` is indeed bound to the visual viewport on iOS 16+, but the layout viewport does not shrink,
so the `height: 100%` inheritance chain ends up picking up the wrong height.

### 3. `safe-area-inset-bottom` does not change with the keyboard

iOS's `safe-area-inset-bottom` (the home indicator gap, typically 34–46px)
does not zero out when the keyboard opens, leaving an extra blank strip below the input bar.

### 4. Body-level bounce scroll

Even when `#root` has the correct height and `overflow: hidden`,
iOS still allows the user to drag in non-overflowing areas and trigger a body scroll.

---

## Solutions

### A. `#root` uses `position: fixed` + `visualViewport.height`

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
// App.tsx — track visualViewport.height and write it into a CSS variable
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

- `position: fixed` takes `#root` out of the document flow so iOS cannot scroll it, and the app bar does not disappear
- `visualViewport.height` is the only value on iOS that correctly shrinks with the keyboard

### B. Layout viewport scroll reset

When the keyboard opens, iOS still scrolls the layout viewport (even if `#root` is fixed),
so we have to immediately scroll it back in the `visualViewport` `scroll` event:

```ts
// App.tsx
vv.addEventListener('scroll', () => window.scrollTo(0, 0));
```

### C. Suppress `safe-area-inset-bottom` via `:focus-visible`

Pure CSS, no JS needed:

```css
/* index.css */
.safe-area-bottom-input {
  padding-bottom: 0.75rem;
  :root:not(:has(input:focus-visible, textarea:focus-visible, [contenteditable]:focus-visible)) & {
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.75rem);
  }
}
```

While the keyboard is open the textarea has `:focus-visible`, so the safe-area padding is suppressed.
After the keyboard collapses, `:focus-visible` goes away and the padding is restored.

### D. `touch-none` to prevent body bounce scroll

Add `touch-action: none` (Tailwind: `touch-none`) to UI areas that should not trigger scrolling:

- StatusBar (`header`)
- Input bar (`div.safe-area-bottom-input`)

The chat message area gets `overscroll-contain` to prevent scroll from propagating up to the body.

---

## Final summary of file changes

| File | Change |
|------|--------|
| `index.html` | Remove `interactive-widget=resizes-content` (no effect on iOS) |
| `index.css` | `#root` uses `position: fixed` + `var(--vv-height)`; `html/body` uses `height: 100%` + `overflow: hidden`; `.safe-area-bottom-input` uses a `:focus-visible` condition |
| `App.tsx` | Track `visualViewport.height` → CSS variable; reset on `scroll` event; intercept body bounce touchmove |
| `ClaudePanel.tsx` | Add `overscroll-contain` to the chat container; add `touch-none` to the input bar |
| `StatusBar.tsx` | Add `touch-none` to the header |

---

## Why this is so messy

iOS Safari's keyboard handling for PWAs is designed differently from native apps,
and several related standards (`interactive-widget`, dynamic updates of `safe-area-inset-bottom`) are either unimplemented or non-conformant on iOS.
These workarounds are currently the only reliable approach, until Apple fixes the underlying issues.
