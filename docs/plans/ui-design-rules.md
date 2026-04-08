# UI Design Rules

General rules derived from past fixes. Each rule includes the reason so future decisions can be made in context.

---

## Mobile Layout

### Root container must use `overflow-hidden`

The root app container (`App.tsx`) must use `overflow-hidden`, not `overflow-auto` or `overflow-scroll`.

**Why:** Browsers automatically scroll the page to bring a focused input into view when the virtual keyboard opens. If the root container is scrollable, this pushes the app bar off-screen. Scrolling must only occur inside designated inner containers (e.g. the messages list).

---

### Use `interactive-widget=resizes-content` in the viewport meta tag

The viewport meta tag in `index.html` must include `interactive-widget=resizes-content`.

**Why:** The default behavior (`resizes-visual`) only shrinks the visual viewport when the keyboard opens — the layout viewport (which `dvh` units depend on) stays the same. This means `h-[100dvh]` doesn't shrink and the input bar gets hidden behind the keyboard. With `resizes-content`, the layout viewport shrinks too, so the flex layout reflows and keeps the input bar visible.

**Compatibility:** iOS Safari 15.4+, Android Chrome 108+. Older browsers ignore it gracefully.

---

### No vertical scrolling inside chat view elements

Inside the chat view (`ClaudePanel.tsx`), only the top-level messages container (`chatContainerRef`) may have `overflow-y-auto`. No other element inside the chat view should have vertical scroll.

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

### No scrollbars anywhere inside the chat view

No element inside the chat view may render a visible scrollbar. This means avoiding `overflow-y-auto`, `overflow-y-scroll`, or `overflow-auto` on any element that is a descendant of the messages list — including collapsible blocks, expanded previews, `<pre>` tags, and inline result views.

**Why:** Nested scrollbars are visually noisy and confusing. On touch devices they also capture scroll gestures (see rule above). The messages list is the one and only scroll surface. If content is long, it should expand in place and let the outer list scroll past it — not introduce its own scroll region.

**How to apply:** When expanding content inline (e.g. a thinking block, tool result, or subagent event list), use `whitespace-pre-wrap break-words` and let height grow naturally. Remove `max-h-*` and `overflow-y-auto` whenever you add expandable content to a chat component.

---
