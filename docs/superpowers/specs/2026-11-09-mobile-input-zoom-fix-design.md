# Mobile Input Zoom Fix (Issue #397) — Design

**Date:** 2026-11-09
**Status:** Draft
**Related:** [Issue #397](https://github.com/tkottke90/amazing-hashbrown/issues/397), [ADR-0060](../adr/0060-mobile-zoom-fix-stops-at-native-select-elements.md), `docs/research/issue-397/01-ios-safari-input-zoom.md` (merged into `main` as part of this work — see D8)

---

## Goal

Stop the raw native form controls across `ui/` that render under 16px from
triggering iOS Safari's zoom-on-focus, without attempting to root-cause the
still-unexplained chat-textarea zoom and without any permanent viewport-meta
restriction.

---

## Problem

iOS Safari zooms the viewport when a focused native `<input>`/`<select>`/
`<textarea>` renders at a computed font-size under 16px (confirmed against
MDN/W3C and corroborated by multiple independent sources — see the research
doc). The shared `Input`/`Textarea` primitives already apply `text-base
md:text-sm` and don't trigger it, but a long tail of raw elements across the
app bypass those primitives and hardcode `text-xs`/`text-sm` unconditionally.

The chat textarea itself already computes to 16px via the shared primitive,
and the research doc could not identify why it still zooms (candidates:
an ancestor `transform`/`zoom`, an iOS text-size accessibility setting, or
an interaction with the primitive's `field-sizing: content`) — that
investigation needs on-device inspection the issue itself already called
for and is out of scope here (D5).

There is no browser API to reset zoom on blur (`VisualViewport.scale` is
read-only, no reset method has shipped), and a permanent
`maximum-scale`/`user-scalable=no` directive on the viewport `<meta>` tag is
permanently ruled out (WCAG 1.4.4; the issue's own Expected Behavior section
already excludes it).

---

## Decisions (and why)

| #   | Decision | Rationale |
| --- | --- | --- |
| D1 | Scope is determined by auditing the actual rendered DOM for native `<input type="text">`/`<select>`/`<textarea>` elements computing under 16px — not by the file/line list in the GitHub comment that proposed this fix. `<label>` elements and non-text input types (`checkbox`, `file`, etc.) are excluded; they never trigger focus-zoom. | The comment's line numbers are already stale against current `main`, and several of its listed hits are `<label>`s or checkboxes — not zoom-triggering elements at all. |
| D2 | Raw `<input>`/`<textarea>` elements migrate to the shared `Input`/`Textarea` primitives wherever practical. A direct `text-base md:text-sm` className edit is the fallback, used only where migration isn't practical. | Both primitives are drop-in wrappers around the same native element; migrating collapses N local copies of the same sizing rule into one, per AGENTS.md's "Composition over Customization." |
| D3 | Raw `<select>` elements get the `text-base md:text-sm` className patch only — never migrated to the `Select` primitive. | See ADR-0060: `Select` is a Radix-based custom dropdown with different markup and value-binding than a native `<select>`; migrating is a real refactor, not a className change. |
| D4 | Textarea migrations (D2) preserve each call site's existing fixed-height/no-resize layout by composing an overriding className (e.g. `h-20 resize-none`) on top of the primitive, rather than adopting the primitive's `field-sizing: content` auto-grow default. | The primitive's default sizing behavior differs from the raw elements' current fixed box; a zoom-focused fix should not silently change layout UX as an unplanned side effect. |
| D5 | The chat textarea's own zoom cause is not investigated or fixed as part of this work, and is not a blocker to closing #397. | Full on-device root-cause investigation is open-ended; this work ships the fixable, well-understood part now rather than holding the whole issue open indefinitely. |
| D6 | A focus/blur viewport-meta `maximum-scale` JS toggle (research doc §2.3 Approach B) is out of scope — not scaffolded, not attempted — regardless of whether D1–D4 turn out to be insufficient. | Real race-condition and cross-browser risk per the research doc's sources; nothing yet shows D1–D4 are insufficient. |
| D7 | A permanent `maximum-scale`/`user-scalable=no` directive on the static viewport `<meta>` tag remains permanently ruled out. | WCAG 1.4.4; already correctly absent from `ui/index.html` today; the issue's own Expected Behavior section rules it out. |
| D8 | The research doc (currently only on branch `claude/adoring-bohr-rtrf4u`, at `docs/research/issue-397/01-ios-safari-input-zoom.md`) is merged into `main` as part of this PR. | It's the permanent record D9's closing comment points to; left stranded on a branch, it could be deleted and orphan that reference. |
| D9 | The comment that closes #397 states explicitly that the original chat-input zoom symptom is **not** confirmed fixed by this change, and points to the now-merged research doc (D8) as the record of the open question — rather than a generic "fixed" close or a link to a tracking issue. | An honest partial close; no new tracking issue is filed for the chat-textarea gap (D5). |
| D10 | Regression coverage is two-layered: a Jest unit test asserting className composition on the fixed elements, plus a Playwright test at a mobile viewport asserting actual computed font-size (`getComputedStyle`) on representative fixed controls. | `ui/jest.config.js` runs `testEnvironment: 'jsdom'`, which does not execute real CSS/media-query layout — a Jest-only check can only see the className string, never the real rendered font-size. Only a real-browser Playwright check can prove the claim. |
| D11 | Merge is gated on a human-performed on-device checklist (real iOS Safari) confirming: each fixed control no longer zooms on focus, app chrome stays visible, and pinch-zoom still works — scoped to the controls this PR actually touches, explicitly excluding the chat textarea (per D5). | No automated test can assert "the page didn't zoom." This is the only check for that, and its scope must match the fix's scope, not the original bug report's scope. |
| D12 | [ADR-0060](../adr/0060-mobile-zoom-fix-stops-at-native-select-elements.md) records the D3 decision. No `GLOSSARY.md` changes. | This work introduces no project-specific domain vocabulary — only implementation/browser terminology, which doesn't meet the glossary's own inclusion bar. |

---

## Non-goals

- Root-causing or fixing the chat textarea's own zoom behavior (D5) — recorded only via the merged research doc (D8/D9), not a new tracking issue.
- Any focus/blur viewport-meta JS toggle (D6).
- Any permanent viewport-meta zoom restriction (D7).
- Migrating native `<select>` elements to the `Select` primitive (D3 / ADR-0060).
- Changing the visual sizing/resize behavior of migrated textareas (D4).

---

## Open implementation notes (not design decisions — flagged for the implementer)

- The actual audited list of files/elements needing a fix (D1) will differ from the GitHub comment's list — produce it by grepping the real DOM at implementation time, not by trusting the comment.
- The Playwright test (D10) needs its representative controls picked concretely: at minimum one migrated `Input`, one migrated `Textarea`, and one patched native `<select>`, each asserted at a mobile viewport width.
- D9's exact closing-comment wording should be finalized at PR-merge time, referencing the research doc's final path on `main` (D8).
