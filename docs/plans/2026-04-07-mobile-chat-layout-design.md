# Mobile Chat Layout Design

## Problem

On mobile, opening the virtual keyboard caused two issues:
1. The app bar was pushed off-screen (the whole page scrolled up).
2. The chat input was hidden behind the keyboard, requiring the user to manually scroll down.

## Root Causes

### 1. Root container had `overflow-auto`

`App.tsx` root div used `overflow-auto`, which allowed the browser's automatic scroll-to-focused-input behavior to scroll the entire page. This pushed the app bar off the top of the screen.

**Fix:** Changed to `overflow-hidden` so scrolling is contained within inner scroll containers only.

### 2. Viewport did not resize layout when keyboard opened

The default `interactive-widget` behavior is `resizes-visual` — only the visual viewport shrinks when the keyboard opens, but the layout viewport (which `dvh` units depend on) stays the same. This meant `h-[100dvh]` did not shrink, so the flex layout didn't reflow and the input bar stayed hidden behind the keyboard.

**Fix:** Added `interactive-widget=resizes-content` to the viewport meta tag in `index.html`. This makes the layout viewport (and therefore `100dvh`) shrink when the keyboard opens, causing the flex layout to reflow and keep the input bar visible.

## Design Rule: No Vertical Scrolling Inside Chat View Elements

Individual elements inside the chat view must not have their own vertical scroll. The only scrollable region should be the messages container (`overflow-y-auto`). Nested scroll containers interfere with the user's scroll gesture — on touch devices, a scroll that starts inside a nested scroll container is captured by that container and never bubbles up to the messages list.

**Rule:** Inside `ClaudePanel.tsx`, no element other than the top-level messages div (ref: `chatContainerRef`) should have `overflow-y-auto`, `overflow-y-scroll`, or `overflow-auto`.

## Summary of Changes

| File | Change |
|------|--------|
| `apps/pwa/index.html` | Added `interactive-widget=resizes-content` to viewport meta |
| `apps/pwa/src/App.tsx` | Root container `overflow-auto` → `overflow-hidden` |

## Browser Compatibility

`interactive-widget=resizes-content` is supported on:
- iOS Safari 15.4+
- Android Chrome 108+

Older browsers ignore the parameter and fall back to default behavior (keyboard may cover input, but no breakage).
