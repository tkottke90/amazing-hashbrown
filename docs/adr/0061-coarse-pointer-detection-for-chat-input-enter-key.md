---
status: accepted
---

# Chat input's mobile Enter-key fix detects input capability, not viewport width — deliberately not reusing `useIsMobileViewport`

Issue #396's fix needs to know whether a device can reliably hold Shift while
tapping Enter, so it can stop sending the message on a bare Enter when it
can't. We detect this with `matchMedia('(pointer: coarse)').matches` alone —
read once on mount, not live-subscribed — rather than reusing the existing
`useIsMobileViewport()` hook (`ui/src/hooks/use-is-mobile-viewport.ts`) or
adding a second signal.

This looks inconsistent at first glance: the codebase already has an
"is this mobile" hook, and a reasonable reader will ask why the chat input
doesn't just use it. It doesn't, because the two hooks answer different
questions. `useIsMobileViewport` is a viewport-width breakpoint, and its own
code comment explicitly rejects pointer-capability detection — for _that_
hook's purpose (does content overflow a narrow layout), a wide touchscreen
tablet doesn't have the problem a narrow desktop window does, so viewport
width is the right signal. The chat input's question is unrelated to layout:
can this user actually press Shift+Enter? A touchscreen laptop with a
physical keyboard can, even in a narrow window; a wide tablet with only a
software keyboard can't, even though its viewport reads as desktop-sized.
Reusing the viewport hook here would reintroduce exactly the misclassifications Q1/Q5 of the issue's design discussion ruled out: a touch
tablet in landscape keeps the broken Enter-always-sends behavior, and a
narrow desktop browser window loses Enter-to-send it didn't need to lose.

We also deliberately did not OR this check with `navigator.maxTouchPoints >
0`: `(pointer: coarse)` reflects the device's _primary_ input mechanism, so
a hybrid touchscreen-plus-keyboard laptop (primary pointer: fine) correctly
keeps desktop Enter-to-send, which is right — it has a working Shift key.
OR-ing in `maxTouchPoints` would flag that same laptop as mobile just
because a touchscreen is present, which is the misclassification we're
avoiding.

## Considered Options

- **Reuse `useIsMobileViewport`'s breakpoint** — rejected: answers "does
  this layout overflow," not "can this user reliably press Shift," and its
  own comment says so.
- **User-agent / platform string sniffing** — rejected: brittle against
  future UA strings, and a long-discouraged web-platform anti-pattern.
- **`navigator.maxTouchPoints > 0`, alone or OR'd with `pointer: coarse`** —
  rejected: flags hybrid touchscreen-plus-keyboard devices as mobile even
  though their physical keyboard works fine.

## Consequences

This codebase now has two distinct "is this mobile" mechanisms answering
two distinct questions: `useIsMobileViewport` (viewport width, for layout)
and this one (pointer capability, for keyboard-modifier reliability). A
future mobile-specific _behavioral_ decision (not layout) should default to
pointer-capability detection, the same way this one does — not the viewport
hook.
