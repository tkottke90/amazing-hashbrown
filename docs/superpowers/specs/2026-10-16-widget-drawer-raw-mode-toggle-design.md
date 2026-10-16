# Widget Edit Drawer — Form/Raw Toggle — Design

**Date:** 2026-10-16
**Status:** Draft
**Related:** [`docs/Design/v1.10.0-Dashboard-Design.html`](../../Design/v1.10.0-Dashboard-Design.html) (interactive prototype this feature draws its "Form"/"Raw" tab framing from), [Slice 2 — Widget Persistence](./2026-10-16-dashboard-widgets-slice2-design.md) (the drawer and raw-recovery flow this spec extends/replaces). Not part of Issue #179 ("Edit Mode Foundation" / Slice 3, drag-resize layout editing) — this is a narrower enhancement to the content-editing drawer Slice 2 already shipped.

---

## Goal

Let a widget's edit drawer toggle between the existing structured **Form**
(title/subtitle/content fields) and a new **Raw** tab that edits the widget's
entire underlying Markdown file — frontmatter and body together, as one
string — directly via CodeMirror. Raw is an "advanced mode": a user who
knows the file format can edit it exactly as they would in a text editor,
with no fields standing in the way.

This also fully replaces Slice 2's standalone raw-recovery editor
(`WidgetErrorCard`'s "Edit raw file" flow). A widget whose file fails to
parse opens into this same drawer and the same Raw tab, rather than a
separate, simpler UI — one mechanism instead of two.

## Problem

The design doc's interactive prototype shows a "Form" / "Raw file" tab pair,
but its "Raw file" tab is a **read-only preview** synthesized from the form
fields ("Generated from the form. Agents and automations write this file
directly.") — not an editable second authoring surface, and it never
mentions CodeMirror. Slice 2 separately built a genuinely editable raw
surface, but scoped it narrowly: a single unconditional, unvalidated
`Textarea`, reachable only from `WidgetErrorCard`, for a file that has
already failed to parse (D9 in the Slice 2 design: "a still-broken save just
shows the same error card again").

Turning Raw into a first-class, always-available editing surface — not just
an error-recovery escape hatch — changes the risk profile: a careless raw
save could now silently corrupt a *healthy* widget, invisible until the next
page load surfaces an error card. This spec's central problem is deciding
how a format only a human and `gray-matter` can judge gets a safety net,
without reintroducing per-keystroke API chatter or blocking the "edit it
like Vim" freedom the feature is explicitly for.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Raw edits the **entire file** — frontmatter and body as one string — not just the `content` body. It uses the existing `CodeEditor` component (CodeMirror 6, markdown language, already theme-matched), not a plain `Textarea`. | Deliberate choice over a lighter "just the body" alternative: gives direct, Vim-like control over `title`/`subtitle`/`order`/etc. with no extra structured UI for fields the Form doesn't expose, and reuses an editor the app already built and themed rather than adding a new one. |
| D2  | The toggle exists only in `edit` mode. `add` (creation) is unchanged — Form fields only.                                                                                                                                      | A widget being created has no file yet to meaningfully "go raw" on.                                                                                                                                                                                                              |
| D3  | `WidgetDrawer`'s `mode` prop collapses from `'add' \| 'edit' \| 'raw'` to `'add' \| 'edit'`. Raw becomes an internal tab (`'form' \| 'raw'`) inside `edit`, not a distinct external drawer mode.                             | A vestigial third mode would just duplicate what the tab now does; the component's API should describe what's actually different (create vs. edit-with-two-views).                                                                                                             |
| D4  | `WidgetErrorCard`'s "Edit raw file" button opens the same `edit`-mode drawer (no separate raw-only drawer) and lands on the Raw tab, with the Form tab disabled.                                                              | One mechanism for "Form can't be shown right now," whether that's because the file never parsed or because the user's in-progress raw edit currently doesn't parse (D6/D7) — not two different disabled-tab stories.                                                          |
| D5  | Default tab is always **Form** for a widget whose structured load succeeded. No per-widget or global memory of the last tab used.                                                                                            | Simplicity: Raw is a deliberate, explicit switch every time, not a sticky preference that could surprise a user who forgot they left it open on Raw last time.                                                                                                                  |
| D6  | Both **Save** and switching **Raw → Form** are locked until the *current* raw text has been validated successfully.                                                                                                          | Without this gate, a single raw save could silently corrupt a healthy widget with no feedback until the next page load's error card. The whole point of promoting Raw to a first-class surface is that it needs its own safety net, where the recovery-only version didn't.   |
| D7  | See state machine below — validation is silent-and-automatic when the text is unchanged since the last check, but requires an explicit **Validate** button click once the user has typed anything since that check.        | Bounds request volume to one call per deliberate check (not one per keystroke, not one per click on a locked button) while still making a stale/broken file self-explanatory the instant you try to leave Raw or save — no separate "click here to find out why" step needed.  |
| D8  | A new endpoint, `POST /api/v1/widgets/validate`, is **not** nested under a widget's own resource path (not `.../widgets/:id/raw/validate`). Body: `{ dashboardId, widgetId, raw }`.                                           | Nesting under `:id` implies the endpoint loads and checks a stored resource. It doesn't — it validates arbitrary submitted text that may not match what's on disk at all. `dashboardId`/`widgetId` are carried only for log correlation, never used to look anything up.        |
| D9  | Validation reuses the exact parsing path `listWidgets` already uses (`gray-matter` + `MarkdownWidgetFrontmatterSchema`), as a pure, no-side-effect dry run. No file is read or written by the validate endpoint.             | One source of truth for "is this file well-formed." A second, slightly different implementation of the same rules is exactly how a validate-endpoint and a load-endpoint quietly drift out of sync.                                                                            |
| D10 | Save-from-Raw still goes through the existing `PUT .../widgets/:id/raw` endpoint, unchanged — still unconditional and unvalidated on the backend.                                                                            | The new validation gate is a client-side safeguard in front of an already-tested, intentionally permissive write path. Keeping the backend permissive preserves the original "a still-broken save just surfaces the same error again" recovery behavior for any caller (e.g. a direct API script) that bypasses the UI gate. |

---

## 1. Validation state machine

Tracked per open drawer instance (reset when the drawer closes/reopens):

```ts
lastChecked: { text: string; result: { ok: true } | { ok: false; error: string } } | undefined
```

- **On entering the Raw tab** (whether the text is freshly serialized from a
  healthy widget's current Form values, or is the stored raw text of a
  widget whose file failed to parse): `lastChecked` starts `undefined`. Save
  and the Form tab are locked.
- **Editing the text** never fires a request. It only matters for comparing
  against `lastChecked.text`.
- **Clicking the locked Save button or the Form tab:**
  - If `lastChecked === undefined`, or `lastChecked.text === currentText`
    (nothing has changed since the last check, including "never checked
    yet"): silently call `POST /api/v1/widgets/validate`, store the result as
    `lastChecked`, then proceed if `ok`, or stay locked and surface
    `lastChecked.error` if not. This is what makes a broken widget's Raw tab
    self-explanatory the moment it's opened and the user tries to leave or
    save, with no separate "please validate" step.
  - If `currentText !== lastChecked.text` (the user has typed something
    since the last check): stay locked; Save and the Form tab remain
    disabled until the user explicitly clicks **Validate**.
- **Clicking Validate** (enabled whenever `currentText !== lastChecked?.text`,
  i.e. whenever there's something new to check): calls the same endpoint,
  stores the result as `lastChecked`, and unlocks Save/Form-tab on success.
- Because the result is cached per exact text, repeatedly clicking a locked
  button while the file is still broken does not re-hit the endpoint — only
  a change to the text, or the very first check, triggers a new call.

## 2. API

New route (not under `dashboards.route.ts`, since it operates on submitted
text rather than a stored dashboard/widget resource) — e.g.
`api/src/routes/v1/widgets.route.ts` + `widgets.handlers.ts`, following the
same thin-route/testable-handler split as `dashboards.handlers.ts`:

| Method | Path                       | Body                                | Notes                                                                 |
| ------ | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| POST   | `/api/v1/widgets/validate` | `{ dashboardId, widgetId, raw }`     | Dry run only — no disk I/O. `dashboardId`/`widgetId` are log context only. Returns `{ ok: true }` or `{ ok: false, error: string }`. |

`lib/amazing-hashbrown-widgets`'s `store.ts` currently parses a file's
frontmatter inline inside `listWidgets`. That per-file parse step is
extracted into its own exported function (e.g.
`parseWidgetFile(raw: string): { ok: true } | { ok: false; error: string }`)
so both `listWidgets` and the new validate handler call the identical logic
— per D9, there is exactly one implementation of "is this file well-formed."

## 3. UI

### 3.1 `WidgetDrawer` / tab structure

- `mode: 'add' | 'edit'` (down from three values, per D3).
- In `edit` mode, an internal `tab: 'form' | 'raw'` signal. Two tab
  buttons/pills labeled "Form" / "Raw" (matching the design doc's own
  wording).
- Entry rules:
  - Opened for a widget whose structured load succeeded → `tab = 'form'`
    (D5).
  - Opened for a widget whose structured load failed (today's
    `WidgetErrorCard` path, D4) → `tab = 'raw'`, Form tab disabled, Raw
    pre-populated with the widget's stored raw text.
- Switching Form → Raw: serialize the current in-memory Form field values
  (title/subtitle/content, plus the original `type`/`order` the widget
  loaded with, which Form never exposes) into the same frontmatter+body
  shape the file is stored in, and seed the Raw editor with that text. This
  resets `lastChecked` to `undefined` for the new tab entry (§1).
- Switching Raw → Form: gated per §1. On success, the just-validated raw
  text is re-parsed into title/subtitle/content and those become the Form
  tab's values (overwriting whatever was in Form before the detour to Raw).

### 3.2 Raw editor

- Reuses `CodeEditor` (`ui/src/pages/workspaces/code-editor.tsx`) exactly as
  already built: pass a `path` ending in `.md` (e.g. the widget's `id +
'.md'`) so it resolves the markdown language extension, `initialContent` =
  the serialized/stored raw text, and a `useRef<EditorView | null>`
  populated via `onReady` to read the live document text out on
  Save/Validate/tab-switch (`view.state.doc.toString()`), matching the
  existing `skill-files-tab.tsx` consumption pattern rather than binding the
  text to a signal on every keystroke.
- A **Validate** button and inline validation status (error message when
  `lastChecked.ok === false`) sit near the tab controls.
- Save and the Form tab button are `disabled` per §1's rules.
- Save still calls `updateWidgetRaw` → `PUT .../widgets/:id/raw` (D10),
  unchanged from Slice 2.

### 3.3 `WidgetErrorCard`

- "Edit raw file" now opens `WidgetDrawer` in `edit` mode (not a separate raw
  drawer) for that widget. The drawer's own entry rules (§3.1) take it to
  the Raw tab automatically — no special-casing in `WidgetErrorCard` itself
  beyond "open the edit drawer."

### 3.4 Test IDs

New/changed `data-testid`s (to be recorded in `e2e/AGENTS.md`'s table,
replacing the now-removed standalone raw-mode entries from Slice 2):

| `data-testid`                | Element                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `widget-drawer-tab-form`     | The "Form" tab button                                         |
| `widget-drawer-tab-raw`      | The "Raw" tab button                                          |
| `widget-drawer-validate`     | The "Validate" button on the Raw tab                           |

`widget-edit-raw-button` (on `WidgetErrorCard`) keeps its existing meaning —
it still opens an edit drawer, just the same one as "Edit" now, defaulted to
Raw.

---

## 4. Testing

Per root `AGENTS.md` and `api`/`ui` `AGENTS.md` conventions:

**`lib/amazing-hashbrown-widgets` (Mocha + Chai):**

- `store.test.ts` [unit] — extend/refactor: the extracted `parseWidgetFile`
  function is unit-tested directly (valid file → `ok`; malformed YAML →
  `ok: false` with an error; valid YAML but failing
  `MarkdownWidgetFrontmatterSchema` → `ok: false`); `listWidgets` tests
  confirm it now delegates to this function rather than inlining the logic.

**`api/` (Mocha + Chai):**

- `routes/v1/widgets.handlers.test.ts` [unit] — new. Valid raw text → `{ok:
true}`; malformed frontmatter → `{ok: false, error}`; confirms no file is
  written (e.g. spy on the fs/store layer showing it's never called) and
  that `dashboardId`/`widgetId` are accepted but not used for any lookup.

**`ui/` (Jest):**

- `widget-drawer.test.tsx` [unit] — substantially rewritten from Slice 2's
  version: `mode="raw"` scenarios removed; `edit` mode now covers both tabs.
  Cases: Form is default tab for a healthy widget; a widget with a load
  error opens directly to Raw with Form disabled; Save/Form-tab start locked
  on Raw entry; an unchanged text's first Save/Form-tab click silently
  validates (mock the validate call) and unlocks on success or shows the
  error and stays locked on failure; editing the raw text re-locks Save/Form
  until Validate is clicked; Validate is a no-op (no second call) if clicked
  again without further edits once already checked for the current text;
  switching Form → Raw → Form round-trips title/subtitle/content correctly
  when the raw text is unedited.
- `dashboard-widget-error-card.test.tsx` [unit] — "Edit raw file" opens the
  edit drawer (not a distinct raw drawer).

**Playwright (`e2e/tests/dashboard.spec.ts`, extend):**

- `@user-workflow` — open an existing widget's edit drawer, switch to Raw,
  make a small content change, click Validate, see Save unlock, save, reload,
  confirm the change persisted.
- `@user-workflow` — switch to Raw, break the frontmatter deliberately
  (e.g. delete a required field), click Validate, confirm Save and the Form
  tab stay locked with an inline error shown.
- `@functional` or `@smoke` — seed a malformed widget file on disk (as
  Slice 2's existing error-recovery test does), open it, confirm it opens
  straight to Raw with Form disabled, fix it, validate successfully, save,
  reload, confirm it now renders normally — replacing Slice 2's old
  raw-mode-specific assertions with the unified flow.

---

## 5. Out of scope

- Any change to `add` (creation) mode — still Form-only.
- Non-markdown widget types — `DashboardWidget` is still only `MarkdownWidget`
  (Slice 2, D10); Raw mode is inherently markdown-file-specific and doesn't
  need to anticipate other types.
- Backend-side validation on the raw-save endpoint itself (D10) — the gate is
  client-side only; a direct API caller can still write an invalid file, same
  as today.
- Drag/resize/position layout editing (Issue #179, Slice 3) — unrelated to
  this spec.
