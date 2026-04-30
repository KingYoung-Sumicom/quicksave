# UI Design Rules

General rules derived from past fixes. Each rule includes the reason so future decisions can be made in context.

---

## Mobile Layout

### Root container must use `overflow-hidden`

The root app container (`App.tsx`) and `#root` (in `index.css`) must use `overflow-hidden`, not `overflow-auto` or `overflow-scroll`. `html, body` are also pinned to `overflow: hidden`.

**Why:** Browsers automatically scroll the page to bring a focused input into view when the virtual keyboard opens. If the root container is scrollable, this pushes the app bar off-screen. Scrolling must only occur inside designated inner containers (e.g. the messages list).

**Companion mechanism:** `#root` is sized via `height: var(--vv-height, 100dvh)` and `App.tsx` listens to `window.visualViewport` to update `--vv-height` whenever the keyboard opens/closes. iOS ignores `interactive-widget=resizes-content` (see next rule), so the JS-driven CSS variable is what actually shrinks the layout on iOS.

---

### Use `interactive-widget=resizes-content` in the viewport meta tag

The viewport meta tag in `apps/pwa/index.html` must include `interactive-widget=resizes-content`.

**Why:** The default behavior (`resizes-visual`) only shrinks the visual viewport when the keyboard opens — the layout viewport (which `dvh` units depend on) stays the same. This means `h-[100dvh]` doesn't shrink and the input bar gets hidden behind the keyboard. With `resizes-content`, the layout viewport shrinks too, so the flex layout reflows and keeps the input bar visible.

**Compatibility:** Android Chrome 108+ honors it. iOS Safari ignores `interactive-widget` entirely — the `--vv-height` / visualViewport listener in `App.tsx` is the iOS fallback (see previous rule).

---

### No vertical scrolling inside chat view elements

Inside the chat view (`apps/pwa/src/components/ClaudePanel.tsx`), only the top-level messages container (`chatContainerRef`, the `flex-1 overflow-y-auto … overscroll-contain` wrapper) and the input-row textarea/slash-command popover may have vertical scroll. No element inside the messages list itself (subagent blocks, tool results, plan views, etc.) may have vertical scroll.

**Why:** On touch devices, a scroll gesture that starts inside a nested scrollable element is captured by that element and does not bubble up to the messages list. This breaks the expected scroll behavior from the user's perspective.

---

## Input / Form Elements

### Textarea must expand to fit content, no max-height cap

Auto-resizing textareas must expand freely (`el.style.height = el.scrollHeight + 'px'`). Do not cap with `Math.min(..., maxPx)`.

**Why:** Capping height re-introduces scroll inside the textarea, which interferes with the user's scroll gesture (same nested-scroll problem as above) and hides content.

---

### Chat view display components must not have max-height limits

Components that display information inside the chat view (tool results, plan views, fallback views, etc.) must not use `max-h-*` combined with `overflow-y-auto`. Let them expand vertically to their full content height.

**Why:** The only scroll container in the chat view is the messages list. Nesting scrollable regions inside it breaks touch scroll (gesture is captured by the inner container) and hides content from the user. Since the messages list already scrolls, there is no need to cap inner components — the user can always scroll past them.

---

### All Enter-to-submit must guard IME composition

Every `onKeyDown` handler that submits on Enter must check `!e.nativeEvent.isComposing`.

```ts
if (e.key === 'Enter' && !e.nativeEvent.isComposing) { submit(); }
```

**Why:** CJK input methods (Chinese, Japanese, Korean) use Enter to confirm a character during composition. Without the guard, pressing Enter to pick a candidate character fires the submit action prematurely, making the input unusable for CJK users.

**How to apply:** Search for `e.key === 'Enter'` across the PWA and verify every occurrence includes `!e.nativeEvent.isComposing`. The main chat textarea in `apps/pwa/src/components/ClaudePanel.tsx` already does this correctly — follow the same pattern everywhere else.

---

### No scrollbars anywhere inside the chat view

No element inside the chat view may render a visible scrollbar. This means avoiding `overflow-y-auto`, `overflow-y-scroll`, or `overflow-auto` on any element that is a descendant of the messages list — including collapsible blocks, expanded previews, `<pre>` tags, and inline result views.

**Why:** Nested scrollbars are visually noisy and confusing. On touch devices they also capture scroll gestures (see rule above). The messages list is the one and only scroll surface. If content is long, it should expand in place and let the outer list scroll past it — not introduce its own scroll region.

**How to apply:** When expanding content inline (e.g. a thinking block, tool result, or subagent event list), use `whitespace-pre-wrap break-words` and let height grow naturally. Remove `max-h-*` and `overflow-y-auto` whenever you add expandable content to a chat component.

---
