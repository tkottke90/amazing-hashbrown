# Wiki Import Error Formatting & Remediation Guidance — Design

**Date:** 2026-08-30
**Status:** Approved
**Issue:** [#92 — Wiki import errors do not provide enough detail](https://github.com/tkottke90/amazing-hashbrown/issues/92)

---

## 1. Problem & Goal

When a wiki upload fails its lint check, `api/src/routes/v1/wiki-upload.route.ts:249-258` builds one flat, semicolon-joined string:

```
Wiki has 3 error-severity lint finding(s) - fix before uploading. frontmatter: Missing or malformed required frontmatter: title, created, uploaded, type, tags, sources.;frontmatter: Missing or malformed required frontmatter: title, created, uploaded, type, tags, sources.;frontmatter: Missing or malformed required frontmatter: title, created, uploaded, type, tags, sources.;
```

This drops each finding's `page` (file path) even though every error-severity lint check already sets it, so a user with three files failing frontmatter validation sees three identical-looking messages with no way to tell which files to fix. The upload modal (`ui/src/pages/wiki/upload-wiki-form.tsx`) then renders this string as unstyled plain text with no scroll cap (so a long error list grows the modal), offers no copy affordance, and has no way back to the form short of closing and reopening — closing itself only resets state on one of the two close paths.

This design fixes both root causes: it plumbs each finding's file path through to the frontend, and it reworks the failure UI to display grouped, copyable, scroll-capped error output with a way back into the form.

---

## 2. Backend: Data Model & Route Change

`UploadJobState`'s `failed` variant (`lib/llm-wiki/src/types.ts`, mirrored in `ui/src/types/wiki-upload.ts`) gains an optional `findings` field:

```typescript
export type UploadJobState =
  | { stage: 'pending' | 'unpacking' | 'validating' | 'registering' | 'linting' }
  | { stage: 'embedding'; pagesEmbedded: number; pagesTotal: number }
  | { stage: 'done'; wikiId: string; lintReport: LintReport }
  | { stage: 'failed'; error: string; findings?: LintFinding[] };
```

`error` keeps its existing meaning — a short human-readable summary — for every failure branch. `findings` is populated only in the lint-error branch, where the data is already structured and already carries a file path:

```typescript
// api/src/routes/v1/wiki-upload.route.ts:249-258
const lintErrors = lintReport.checks.filter((c) => c.severity === 'error');
if (lintErrors.length > 0) {
  setUploadState(jobId, {
    stage: 'failed',
    error: `Wiki has ${lintErrors.length} error-severity lint finding(s) — fix before uploading.`,
    findings: lintErrors,
  });
  await rollback(wikiId, wikiDestPath, jobId);
  return;
}
```

No changes are needed to the lint checks themselves (`lib/llm-wiki/src/internal/lint/checks.ts`) — `checkFrontmatter` and `checkBrokenLinks`, the only two error-severity checks, already set `page: page.relPath` on every finding they produce.

**Not changed:** every other failure branch in `processUpload` (registration failure, "lint check failed to run," rollback errors, a thrown exception caught at the top level) continues to set only `error`, leaving `findings` `undefined`. These are not lint findings and are not force-fit into the `LintFinding` shape.

---

## 3. Frontend: Rendering

### Reused `CodeBlock`, with one prerequisite fix

`ui/src/components/markdown.tsx`'s `CodeBlock` is already imported and used elsewhere in `upload-wiki-form.tsx` (for the tar/zip creation snippets) and is the right component to reuse for the error output — it already provides a hover-revealed copy button. It currently merges classes as:

```typescript
className={cn(props.className, 'overflow-hidden whitespace-pre-line')}
```

Because `cn` resolves conflicting Tailwind utilities in favor of whichever appears **last**, a caller-supplied `overflow-y-auto`/`max-h-*` would currently lose to the hardcoded `overflow-hidden`. Flip the argument order:

```typescript
className={cn('overflow-hidden whitespace-pre-line', props.className)}
```

This is a one-line, backward-compatible fix (existing callers that pass no overflow/whitespace override are unaffected) and is required for the error block to be able to scroll at all.

### Error display

In `upload-wiki-form.tsx`, the failure branch (`isFailed`, currently lines 237-241) is replaced with a `CodeBlock` given a fixed max-height and `overflow-y-auto`, so additional findings scroll inside the block instead of growing the modal:

- **When `jobState.value.findings` is present** (lint failures): group findings by `page` client-side (a plain reduce into `Map<string | undefined, LintFinding[]>`; findings with no `page` — there are none among today's error-severity checks, but the type allows it — render under a generic heading). Render the summary `error` line, a blank line, then each file as a heading with its findings nested underneath:

  ```
  Wiki has 3 error-severity lint finding(s) — fix before uploading:

  raw/articles/test.md
    - frontmatter: Missing or malformed required frontmatter: title, created, tags.
  entities/user.md
    - frontmatter: Missing or malformed required frontmatter: title.
  ```

- **When `findings` is absent** (every other failure type): render `error` as-is inside the same `CodeBlock`. Same box, same copy button, same scroll cap — just nothing to group.

### Buttons

- **On success (`isDone`):** unchanged — a single "Close" button.
- **On failure (`isFailed`):** two buttons instead of one:
  - **"Back to Form"** (primary) — clears `jobId`/`jobState` and stops the poll interval (same cleanup `reset()` already does for those fields), keeps `name.value` as-is, and clears `file.value`. The user lands back on the upload form with the wiki name still filled in and must attach a corrected archive.
  - **"Close"** — unchanged behavior: full `reset()` then `close()`.

---

## 4. Interaction: Close-Clears-Form Fix

Per `ui/src/components/AGENTS.md`'s documented pattern, the `Dialog`/`Modal` component's built-in header X button fires the consumer-supplied `onCancel` prop — not `onClose`, which only fires through `useDialog().close()`. `UploadWikiDialog` currently sets neither, so clicking the X bypasses `reset()` entirely, leaving stale `file`/`name`/`jobId`/the poll interval in signals for the next time the modal opens. The fix is local and uses the already-supported hook:

```tsx
<Modal title="Upload Wiki" onCancel={reset} trigger={...}>
```

(`reset` needs to be lifted or otherwise reachable at the `UploadWikiDialog` level, since `onCancel` is a prop on `Modal` while `reset` currently lives inside `UploadWikiForm`.)

**Known limitation, explicitly out of scope:** pressing Escape on the native `<dialog>` element does not appear to be wired to `onCancel` anywhere in `lib/preact-dialog` (no listener for the dialog's native `cancel`/`close` events), so Escape would still bypass `reset()`. This is a pre-existing gap affecting every modal in the app, not something introduced by or specific to this issue. Fixing it would mean changing the shared `Dialog` component's event wiring, which has a blast radius beyond this issue (every `Modal`/`Drawer`/`BottomSheet` consumer). It is called out here as a candidate follow-up, not addressed by this design.

---

## 5. Modal Width Cap (App-Wide)

Separately from the error-formatting work, the `Modal` component (`lib/preact-dialog/src/Modal.tsx`) currently sets only a *min*-width (`min-w-10/12`, growing to `sm:min-w-150`) with no max-width at all, so any modal grows to fit its content — observed on the Upload Wiki modal reaching ~95% of viewport width on larger screens. This design adds a max-width cap to `MODAL_CLASSNAME` itself, so every modal in the app is capped, not just Upload Wiki:

```typescript
const MODAL_CLASSNAME = `
  fixed inset-0 block pointer-events-none opacity-0 mx-auto my-4 min-w-10/12
  transition-opacity transition-discrete duration-200
  sm:min-w-150
  lg:max-w-[60vw]
  backdrop:backdrop-blur-xs ...
`;
```

- Below the `lg` breakpoint (1024px — screens up to and including typical tablet width, portrait or landscape) behavior is unchanged: modals still size to their `min-w-10/12`/content width, uncapped.
- At `lg` and above, no modal panel exceeds 60% of the viewport width, regardless of content.
- Per-modal `className` overrides (e.g. `NewDomainModal`'s `max-w-11/12 md:max-w-lg`) still apply on top via `twMerge` inside `Dialog`'s `className={`...${MODAL_CLASSNAME}...${className ?? ''}`}\`` — a modal that already declares its own, tighter max-width keeps it; this change only adds a ceiling for modals (like Upload Wiki) that declare none today.
- This is the one change in this design that isn't scoped to the Upload Wiki modal — it touches the shared `lib/preact-dialog` package and therefore every `Modal` consumer (`rate-modal.tsx`, `provider-modal.tsx`, `tracker-config-modal.tsx`, `new-domain-form.tsx`, `upload-wiki-form.tsx`). None of the others currently declare a wider max-width than 60vw would allow at their typical content sizes, so no visual regression is expected, but this should be eyeballed on each during implementation.

---

## 6. Testing

- **Backend:** add a Mocha/Chai test for `wiki-upload.route.ts`'s lint-failure branch (no test file exists for this route yet) confirming `findings` is present and each entry retains its `page`, following the pattern in `api/src/routes/v1/workspace-files.handlers.test.ts`.
- **Frontend:** no `*.test.tsx` files exist anywhere in `ui/src` yet despite Jest being configured (`ui/jest.config.js`). Rather than stand up the first component test as a side effect of this issue, this change is verified manually: upload a wiki with multiple files failing frontmatter/broken-link checks and confirm (a) findings are grouped by file, (b) the box scrolls instead of growing the modal, (c) the copy button copies the full grouped text, (d) "Back to Form" returns to the form with the name retained and the file cleared, and (e) closing via the Close button, the header X, and a non-lint failure (e.g. simulate a registration failure) all leave the form fully reset on next open.
- **Modal width cap:** at a viewport width above the `lg` breakpoint (1024px), confirm the Upload Wiki modal (and a spot check of one or two other modals, e.g. `NewDomainModal`, `RateModal`) never exceeds 60% of viewport width; below `lg`, confirm sizing is unchanged from current behavior.

---

## 7. Files Changed

| File | Change |
| --- | --- |
| `lib/llm-wiki/src/types.ts` | Add optional `findings?: LintFinding[]` to `UploadJobState`'s `failed` variant |
| `ui/src/types/wiki-upload.ts` | Mirror the same `findings?: LintFinding[]` addition |
| `api/src/routes/v1/wiki-upload.route.ts` | Lint-failure branch (~line 249-258): pass `lintErrors` through as `findings`, shorten `error` to the summary line only |
| `ui/src/components/markdown.tsx` | `CodeBlock`: swap `cn()` argument order so caller `className` can override `overflow`/`whitespace` |
| `ui/src/pages/wiki/upload-wiki-form.tsx` | Replace plain-text failure `<div>` with grouped/scrollable `CodeBlock`; add "Back to Form" button and its handler; wire `onCancel={reset}` on the `Modal` in `UploadWikiDialog` |
| `api/src/routes/v1/wiki-upload.handlers.test.ts` (new, name to match sibling `*.handlers.test.ts` convention) | Cover the lint-failure branch's `findings` output |
| `lib/preact-dialog/src/Modal.tsx` | Add `lg:max-w-[60vw]` to `MODAL_CLASSNAME`, capping every modal's width above the tablet breakpoint |

---

## 8. Out of Scope

- Fixing Escape-key dismissal bypassing `onCancel`/`onClose` in the shared `lib/preact-dialog` package — a pre-existing, app-wide gap, not specific to this issue (see §4).
- Adding per-finding remediation hints beyond the existing lint check `message` text (e.g. "add a `title:` field to frontmatter") — the issue's acceptance criteria ask for identifying *which file* and *why*, both already carried in the existing `LintFinding.message`; authoring new guidance text per check is a separate effort.
- Standing up the first Jest component test suite for `ui/src` — deferred per §6; this issue is verified manually instead.
- Grouping or restructuring the non-error-severity lint findings shown on the success path (`isDone`'s "N lint finding(s) to review" line) — only the failure path's display is in scope.
- A pixel-perfect design pass on every other modal (`rate-modal.tsx`, `provider-modal.tsx`, `tracker-config-modal.tsx`, `new-domain-form.tsx`) at the new 60vw cap — per §5, a visual smoke check during implementation is sufficient; none are expected to regress.
