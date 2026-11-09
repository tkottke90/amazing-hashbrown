# Research: Mobile Browser Auto-Zoom on Input Focus (No Zoom-Out on Blur)

Research for [issue #397](https://github.com/tkottke90/amazing-hashbrown/issues/397).

## 1. Overview of the Question

On mobile browsers, focusing the chat input zooms the page in, and nothing
reverses that zoom when the input is blurred — the user has to pinch back out
manually every time. The issue body already rules out the most common
assumed cause (the chat textarea's rendered font-size) by observation, and
asks for real investigation rather than a single assumed fix. The question
this doc answers: **what is the documented mechanism behind this behavior,
what workarounds do real projects actually use, and does the fix generalize
to "any other input" as the issue's Expected Behavior section asks?**

## 2. Information Found

### 2.1 The mechanism: iOS Safari's focus-zoom heuristic

The long-standing, widely corroborated rule (Stack Overflow's canonical
thread, Rick Strahl's West Wind write-up, and the `specification.website`
accessibility reference all state this independently): **iOS Safari
zooms the viewport in when a focused `<input>`, `<select>`, or `<textarea>`
has a _rendered_ font-size under 16px**, on the theory that the user needs
help reading/editing small text. Key details:

- It's the **rendered/computed** size that matters, not the declared one.
  A value that looks like `16px` in the stylesheet can still compute lower
  after `rem`/`clamp()`/inheritance/an ancestor `transform: scale()` or CSS
  `zoom`, or a browser "Text Size" accessibility setting (per
  `specification.website`'s mobile-form-inputs page and corroborating
  commentary in the search results above).
- The rule applies per-element to `input`, `select`, and `textarea` — not to
  the page as a whole. Any one small field can trigger it.
- Safari does **not** zoom back out automatically on blur. This is the part
  of the bug with no built-in browser remedy (see §2.2).
- This is iOS Safari-specific; it does not reproduce the same way on desktop
  Safari, and Firefox Mobile's form-zoom behavior isn't governed by the
  viewport meta tag at all (per the chat-app/mobile-zoom search results).

### 2.2 There is no API to force the zoom back out programmatically

Checked directly against MDN's `VisualViewport` reference
(developer.mozilla.org/en-US/docs/Web/API/VisualViewport, fetched directly):

- `VisualViewport.scale` ("the pinch-zoom scaling factor applied to the
  visual viewport") is documented as **read-only**. There is no setter and
  no method on the interface to assign a new scale.
- The interface only exposes `resize`/`scroll`/`scrollend` events and
  read-only geometry (`offsetLeft/Top`, `pageLeft/Top`, `width`, `height`,
  `scale`) — it's observational, not a control surface.
- This matches a live W3C CSSOM-view discussion (referenced in search
  results, `lists.w3.org` Jan/Feb 2024 thread) proposing a
  `VisualViewport.resetScale()` method precisely because no such reset
  exists today — it has not shipped.

**Conclusion: nothing can zoom the page back out on blur after the fact.**
The only real levers are (a) preventing the zoom from happening in the first
place, or (b) suppressing/restricting the browser's zoom gesture around the
focus event itself.

### 2.3 How other projects actually solve it

**Approach A — Font-size floor (the standard, accessibility-safe fix; most sources treat this as "the" answer).**
Ensure every focusable form control renders at ≥16px on touch devices,
unconditionally — not just under `:focus`. One Stack Overflow report
specifically noted that setting 16px _only_ on the `:focus` state still let
the zoom fire, because the browser evaluates the focus-time computed style
each time, and by then the zoom decision already fired, or the base state
was still small. The fix needs to apply at rest, typically via a
`@media (pointer: coarse)` query or a mobile-first breakpoint (exactly the
`text-base md:text-sm` pattern — see §3). No accessibility downside, no
effect on pinch-zoom elsewhere on the page.

**Approach B — Temporarily restrict the viewport meta tag around focus/blur (used historically, e.g. Wikimedia VisualEditor's `ViewportZoomHandler.js`, older jQuery snippets, at least one project commit found in search).**
On focus, set `maximum-scale=1` on the `<meta name="viewport">` element
(by replacing the whole meta element rather than mutating its `content`
attribute in place — one commit author specifically called out that modern
iOS handles a full element replace more reliably than an attribute
mutation); on blur, restore the original content after a short delay
(~100ms in the reports that worked around race conditions). Caveats found
across multiple independent sources:

- Timing/race conditions are commonly reported — a simple focus/blur toggle
  "didn't work" for at least one Stack Overflow poster, who had to add the
  ~100ms delay.
- `maximum-scale` is interpreted inconsistently across browsers — reports
  disagree on whether it blocks pinch-zoom on Android/other browsers even
  when scoped to the focus window.
- Every accessibility-focused source (`specification.website`'s
  meta-viewport page explicitly, citing WCAG 1.4.4 "Resize Text") calls out
  `maximum-scale=1`/`user-scalable=no` as the thing to avoid, even when
  temporary, because it's easy to get the restore-on-blur logic wrong and
  leave users stuck unable to zoom. This is a weaker guarantee than
  Approach A, not a cleaner one — it manages a symptom via a page-wide
  control that has real failure modes, rather than removing the trigger.

**Approach C — Never: permanently setting `maximum-scale=1` / `user-scalable=no` in the static `<meta>` tag.** Every source checked (the two WCAG-citing
accessibility pages, plus the general search results) flags this as
disabling pinch-zoom outright and failing WCAG 1.4.4 (Resize Text, AA). The
issue's own Expected Behavior section already rules this out ("Pinch-to-zoom
itself... is not disabled as a side effect of the fix"), and the project's
current `ui/index.html` correctly has no such directive today.

**A related-but-distinct problem, for context:** WebKit bug
[254861](https://bugs.webkit.org/show_bug.cgi?id=254861) (fetched directly,
status NEW/unresolved as of last update 2025-03-24) describes iPadOS
installed-web-app viewport _offset_ not restoring correctly after the
on-screen keyboard is dismissed — a layout/hit-testing bug, not the
zoom-on-focus behavior this issue describes, and iPhone is explicitly
reported as unaffected. It's not the same bug, but the workaround pattern
commenters use (re-registering a `visualViewport` `resize` listener on every
focus, reading `visualViewport.height`/`offsetTop` inside
`requestAnimationFrame` because the event can fire before the viewport
value updates, then correcting `scrollTop`) is the general template anyone
reaches for when they need to react to viewport-geometry changes around
focus/blur on iOS — worth knowing if layout (not just zoom) issues show up
during on-device testing, but it does not reset zoom `scale` itself (which,
per §2.2, cannot be reset by script at all).

## 3. Repo-Specific Findings

- `ui/src/style.css:170-173` sets `html { font-size: 16px }` explicitly, and
  there is no Tailwind `fontSize`/`--text-base` override anywhere in `ui/`
  (Tailwind v4, config lives in `@theme` blocks in `style.css`, not a
  `tailwind.config.*` file). So `text-base` (`1rem`) reliably computes to
  16px project-wide — the shared primitives `ui/src/components/ui/input.tsx`
  and `ui/src/components/ui/textarea.tsx` (`text-base md:text-sm`) are
  already doing the right thing, confirming the issue's own observation that
  the obvious font-size cause doesn't explain the chat input specifically.
- However, a long tail of **raw, native `<input>`/`<select>`/`<textarea>`
  elements bypass those shared primitives** and hardcode `text-sm` (14px) or
  `text-xs` (12px) unconditionally, with no mobile-safe floor — these _will_
  trigger the same zoom-on-focus behavior on mobile and are the concrete
  match for the issue's "or any other input" wording:
  - `ui/src/components/task-drawer.tsx` — multiple `text-sm` textareas,
    selects, and a plan-step input (lines ~786, 798, 874, 1021, 1146, 1199,
    1241, 1293, 1312, 1397, 1486)
  - `ui/src/components/task-board/board-callout.tsx:102` — `text-xs` select
  - `ui/src/pages/wiki/document-view.tsx` — several `text-xs`/`text-sm`
    inputs/selects/textareas (lines ~67, 75, 86, 231, 440)
  - `ui/src/pages/wiki/new-domain-form.tsx` and `upload-wiki-form.tsx` —
    `text-xs` inputs/textareas
  - `ui/src/pages/workspaces/workspace-settings-drawer.tsx`,
    `file-tree.tsx`, `index.tsx` — `text-sm`/`text-xs` textareas/input
- Only one `<meta name="viewport">` exists in the shipped app
  (`ui/index.html:14`, `width=device-width, initial-scale=1.0`); no
  `maximum-scale`/`user-scalable` directive, and no PWA manifest. No
  existing JS workaround of any kind (`visualViewport`, focus/blur viewport
  toggling, etc.) exists anywhere in `ui/` today.
- Still unexplained by any of the above: if the chat textarea itself
  computes to 16px, why does the issue report it zooming? That specifically
  needs the on-device check the issue already calls for — inspect the
  _actual rendered_ font-size in Safari's remote Web Inspector while the
  field is focused, and rule out an ancestor `transform`/`zoom`, an iOS
  "Larger Text" accessibility setting changing the effective computed size,
  or `field-sizing: content` (used in `textarea.tsx`) interacting with the
  timing of the zoom heuristic. None of the sources found here document a
  `field-sizing`-specific interaction, so this is a gap, not a confirmed
  cause.

## 4. Candidate Approaches, Ranked

1. **Fix the font-size floor on every raw form control** (§2.3 Approach A) —
   apply the same `text-base md:text-sm` pattern the shared `ui/input.tsx`/
   `ui/textarea.tsx` primitives already use to the raw elements listed in
   §3, ideally by routing them through those shared primitives instead of
   re-declaring font-size locally (this is also what the repo's own
   "Composition over Customization" principle in `AGENTS.md` argues for —
   one shared sizing rule every consumer composes with, not N local copies
   that can drift). This is the fix with no accessibility trade-off and the
   one every primary/secondary source converges on as correct. It won't by
   itself explain the chat-input case (§3's open gap) if that field is
   already at 16px, so it should be paired with on-device inspection.
2. **On-device investigation of the chat textarea specifically** — confirm
   actual rendered font-size via Safari Web Inspector, check for ancestor
   `transform`/`zoom`, and check `field-sizing: content` behavior, before
   assuming #1 covers every case.
3. **Scoped focus/blur viewport-meta toggle** (§2.3 Approach B) — only if
   #1/#2 don't fully resolve it. Carries real race-condition and
   cross-browser risk per the sources above, and is the one approach that
   needs the most on-device soak testing before shipping. No permanent
   `maximum-scale`/`user-scalable` directive should land in the static
   `ui/index.html` meta tag regardless (ruled out by the issue itself and by
   every accessibility source checked).
4. **Do not rely on any zoom-reset-on-blur mechanism** — confirmed (§2.2)
   that no such browser API exists, so no implementation path should assume
   one.
