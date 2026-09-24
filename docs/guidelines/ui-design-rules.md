# UI Design Rules

General rules derived from past fixes. Each rule includes the reason so future decisions can be made in context.

---

## Quicksave PWA Interface Style

Use `apps/pwa/src/components/settings/SettingsNavigation.tsx` and
`apps/pwa/src/components/ProjectList.tsx` as current examples when changing
navigation, settings, session lists, or filters.

- Use a dark slate base (`slate-900`), slightly lighter surfaces (`slate-800`),
  and quiet borders (`slate-700`). Use blue for the selected item and primary
  actions; retain distinct semantic colors for status and danger.
- Use `rounded-xl` for navigation items, cards, and sections; use `rounded-lg`
  for controls and dropdowns. Prefer a subtle border, hover surface, and
  selected ring over strong shadows or decoration.
- Establish hierarchy with a clear item title, muted secondary metadata, and
  small uppercase group labels. Use counts and status chips where they help
  scanning. Highlight the current item with a blue tint and visible keyboard
  focus.
- Keep primary navigation visible. Put occasional controls such as session
  filters in a disclosure that starts closed; show an active-filter indicator
  while it is closed and preserve the selected values. Avoid repeating a
  section title directly under an already labeled active tab.
- Preserve the same groups and actions on desktop and mobile. Keep desktop
  sidebar rows compact and give primary mobile navigation and dropdown
  triggers at least a 44px touch target. Keep the machine and project filters
  side by side in the mobile session list; truncate long selected names within
  their controls.
- Custom filter dropdowns must expose expanded and selected states, support
  keyboard movement and Escape, close on outside interaction, and use localized
  labels. Reuse an existing control pattern when extending another view.
- When an action needs both a machine and a project, choose the machine first,
  then show only its projects. Keep a Back action and an empty state for
  machines with no projects; do not skip the picker for a single project.

**Why:** A consistent hierarchy makes dense session and settings views easier
to scan, while disclosure keeps infrequent controls available without taking
space from the main list. Shared desktop and mobile behavior reduces surprises.

---

## Fixed-size Terminal Layout

The xterm grid is locked to 80×24. Keep its host at the available width so
FitAddon can measure it, then center the actual `.xterm` element within the
host. Give the host and terminal different background colors: centering only
`.xterm-screen` leaves the absolute `.xterm-viewport` stretched across the
host. Let a full-page host grow beyond the viewport height so all 24 rows
remain reachable by vertical scrolling on short screens.

Terminal create, input, rename, and close failures should appear in the view
where they happened. Leave the terminal page open when close fails, and keep
the rename field editable when its request is rejected.

---

## Mobile Layout

### Connection feedback must belong to the viewed machine

Session and project connection indicators must read the owning machine's
connection state, including retry counts, handshake progress, and online status.
Background reconnects must not show a blocking overlay over the home page or
unrelated machines. Reserve the full-screen connection overlay for an explicit
connection flow.

**Why:** Machines reconnect independently; one unavailable machine must not
make healthy sessions appear disconnected or prevent navigation to them.

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

### Splash screen must not reappear on app backgrounding

The static `#app-splash` in `apps/pwa/index.html` is a cold-start mask only.
Once React has mounted and hidden it, do not remove its `fade-out` class on
`pagehide` or `visibilitychange: hidden`.

**Why:** On iOS PWAs, returning from another app can leave a stale WebSocket
or delayed foreground event while the app is already interactive. If the splash
is shown again during backgrounding, a slow reconnect path can look like the
entire app is stuck on the launch screen.

---

### No vertical scrolling inside chat view elements

Inside the chat view (`apps/pwa/src/components/SessionPanel.tsx`), only the top-level messages container (`chatContainerRef`, the `flex-1 overflow-y-auto … overscroll-contain` wrapper) and the input-row textarea/slash-command popover may have vertical scroll. No element inside the messages list itself (subagent blocks, tool results, plan views, etc.) may have vertical scroll.

**Why:** On touch devices, a scroll gesture that starts inside a nested scrollable element is captured by that element and does not bubble up to the messages list. This breaks the expected scroll behavior from the user's perspective.

---

## Input / Form Elements

### Keep submitted drafts until the agent acknowledges them

Message composers must retain and synchronously persist submitted text while
the send command is awaiting its agent acknowledgement. Disable editing and
duplicate submission during that window, and do not show the matching user
message in the conversation list yet—even if its provider card event arrives
before the command response. Clear the text and persisted draft and reveal the
user message only after a successful acknowledgement; on timeout or rejection,
unlock the composer with the original text intact so the user can retry.

**Why:** Transport failures can happen after the user presses send but before
the agent accepts the command. Clearing optimistically loses the only copy of
the message and makes retry impossible.

### Make active-turn message delivery explicit

The composer defaults to queueing a prompt as the next turn. Expose insertion
and interruption as per-send choices only while a turn is active; reset the
choice after a successful send or session switch. Disable insertion when the
provider has no safe same-turn input capability, and keep the draft when the
agent rejects an unsupported mode.

**Why:** A provider's native mid-turn behavior can differ from another's;
an ordinary Send must never unexpectedly steer or cancel running work.

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

**How to apply:** Search for `e.key === 'Enter'` across the PWA and verify every occurrence includes `!e.nativeEvent.isComposing`. The main chat textarea in `apps/pwa/src/components/SessionPanel.tsx` already does this correctly — follow the same pattern everywhere else.

### Mobile prompt Enter must insert a newline

In the multiline session composer, intercept an unmodified Enter to send only
in the desktop layout (`min-width: 768px`). On mobile, leave Enter to the
textarea's native newline behavior, including while slash suggestions are
open; the visible Send button submits the prompt. Keep the IME composition
guard on desktop. Use the layout media query rather than touch-event presence
because touch-capable desktop browsers still need their normal keyboard flow.

**Why:** Mobile keyboard users need a reliable way to write multiline prompts.
Submitting on Enter can send an incomplete prompt before they can add a line.

---

### No scrollbars anywhere inside the chat view

No element inside the chat view may render a visible scrollbar. This means avoiding `overflow-y-auto`, `overflow-y-scroll`, or `overflow-auto` on any element that is a descendant of the messages list — including collapsible blocks, expanded previews, `<pre>` tags, and inline result views.

**Why:** Nested scrollbars are visually noisy and confusing. On touch devices they also capture scroll gestures (see rule above). The messages list is the one and only scroll surface. If content is long, it should expand in place and let the outer list scroll past it — not introduce its own scroll region.

**How to apply:** When expanding content inline (e.g. a thinking block, tool result, or subagent event list), use `whitespace-pre-wrap break-words` and let height grow naturally. Remove `max-h-*` and `overflow-y-auto` whenever you add expandable content to a chat component.

---

### User-facing deliverables must not be hidden by tool-call folding

Artifact cards are boundaries in folded tool-call or completed-turn runs and
must remain visible. This includes artifact references transported inside a
tool-call result when a provider does not emit a standalone artifact card.
Keep the chat representation compact (title, format, and size); fetch and render
the artifact only after the user opens it in the desktop session panel or the
mobile full-screen preview.

**Why:** An artifact is the requested deliverable, not operational detail.
Folding it with the tool invocation makes completed work appear to be missing,
while rendering the full report inline overwhelms the conversation and adds a
nested scroll surface.

---

### Local Markdown images must use the file-read pipeline

Markdown renderers and image-view cards must load local image paths through the
shared `LocalFileImage` component and `files:read`, including the PWA file cache.
Do not assign filesystem paths or `file://` URLs directly to browser `<img>`
elements, and do not embed image bytes in card snapshots.

**Why:** Browser/PWA security rules cannot directly read the agent machine's
filesystem. Fetching on demand keeps cards metadata-only, works across remote
agents, and lets every local-image surface share cache and error behavior.

---

### Filter non-rendering cards before building the display sequence

Cards whose rendered Markdown is empty (for example, whitespace-only assistant
text) must be removed before tool-call grouping, completed-turn folding, and
message wrapper creation. Thinking cards belong to the same folded operational
run as adjacent tool calls when tool-call hiding is enabled.

**Why:** Returning `null` from the inner message renderer is too late. The outer
card wrapper can still create spacing, and the logically empty card can split
two adjacent tool calls into separate folded groups.

---

### Cursor-paged history must advance even when a page renders no cards

Use the source cursor to request the next page; do not derive the next offset
from the number of rendered cards. A page of native items can produce zero UI
cards. Re-observe the top sentinel after a cursor change, but cap consecutive
automatic empty-page requests and leave a manual "Load older" control.

**Why:** Otherwise an empty item page permanently hides older history, while
unbounded auto-retries can scan an entire long session just to fill the screen.

---
