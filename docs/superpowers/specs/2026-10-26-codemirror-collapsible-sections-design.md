# CodeMirror Collapsible Sections — Design

**Date:** 2026-10-26
**Status:** Draft

---

## Goal

Large files opened in the Workspace Files tab currently have no way to collapse sections, so users scroll through the whole file to navigate. Add CodeMirror code folding to the shared `CodeEditor` component, with per-section gutter controls and whole-file Collapse All / Expand All buttons on the Workspace Files toolbar.

---

## Problem

`ui/src/pages/workspaces/code-editor.tsx` is the single `EditorView` setup used by every CodeMirror consumer in the app (Workspace Files tab, skill files, skill details, the widget drawer's CSV/Markdown editors). Its extension list has no folding support at all — no `foldGutter`, no `foldService`, no `codeFolding` — despite every configured language package (`@codemirror/lang-javascript`, `-python`, `-json`, `-markdown`, `-html`, `-css`) already shipping the node props folding needs. YAML isn't configured at all today; `.yaml`/`.yml` files fall through `languageForPath` to plain text.

The pain point is specifically the Workspace Files tab (`ui/src/pages/workspaces/files-tab.tsx`), where files can get large enough that scrolling becomes the main way users navigate them.

---

## Non-goals

- Collapse All / Expand All buttons in the other three `CodeEditor` consumers (`skill-files-tab.tsx`, `skill-details-tab.tsx`, `widget-drawer.tsx`). They get per-section gutter folding for free since it's in the shared component, but no toolbar changes — nobody asked for it there.
- Persisting fold state across page reloads or server-side. In-session persistence (surviving a tab switch) falls out of the existing "tabs stay mounted, hidden via CSS" architecture in `files-tab.tsx` for free — no new state to design.
- Folding for file types with no language package at all (e.g. plain `.txt`, `.env`) — `languageForPath` already returns `[]` for those and that's unchanged.
- Content sniffing frontmatter in non-Markdown files, or supporting delimiters other than `---`.

---

## Design

### 1. Generic folding — `code-editor.tsx`

Add two extensions from `@codemirror/language` to the shared extension list (`code-editor.tsx:105-117`), alongside the existing `lineNumbers()`, `history()`, etc.:

```ts
import { foldGutter, codeFolding, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

// ...
extensions: [
  lineNumbers(),
  foldGutter(),
  codeFolding(),
  history(),
  // ...existing entries
],
```

`codeFolding()` provides the fold state/commands; `foldGutter()` renders the clickable fold markers. Every language already configured (JS/TS/JSX, Python, JSON, Markdown, HTML, CSS) gets working fold regions immediately — brace/bracket blocks, Python indentation blocks, JSON objects/arrays, Markdown headings/lists/fenced code blocks — since each `@codemirror/lang-*` package already defines `foldNodeProp` rules. No per-language code needed.

### 2. YAML support

Add `@codemirror/lang-yaml` as a new dependency and register it in `EXTENSION_LANGUAGE` (`code-editor.tsx:20-34`):

```ts
import { yaml } from '@codemirror/lang-yaml';

const EXTENSION_LANGUAGE: Record<string, () => LanguageSupport> = {
  // ...existing entries
  yaml: yaml,
  yml: yaml,
};
```

This gives `.yaml`/`.yml` files syntax highlighting (previously plain text) and folding (mapping/sequence blocks) in one change, consistent with how every other language is registered.

### 3. Markdown frontmatter fold rule

Markdown's generic heading/list/fence folding doesn't recognize a leading `--- ... ---` YAML frontmatter block as a unit — it's not a heading or a fenced code block. Add a small dedicated `foldService`, scoped to the Markdown language only, in a new file `ui/src/pages/workspaces/markdown-frontmatter-fold.ts`:

- Exports a pure function `frontmatterFoldRange(doc: Text): {from: number, to: number} | null` (unit-testable without a DOM or `EditorView`):
  - Returns `null` if line 1 isn't exactly `---`.
  - Scans forward for the next line that is exactly `---`.
  - Returns `null` if no closing `---` is found (unterminated/no frontmatter).
  - Otherwise returns the range spanning from the end of line 1 to the start of the closing `---` line — the body between the delimiters, so the delimiter lines themselves stay visible when collapsed.
- Exports a `foldService`-compatible extension wrapping that function, registered conditionally for Markdown documents (e.g. via `markdown({ extensions: [frontmatterFoldExtension] })` or appended alongside the `markdown()` `LanguageSupport` in `EXTENSION_LANGUAGE.md`/`.markdown`).

Because the check only ever looks at line 1, a `---` horizontal rule later in the document body never triggers a false fold region.

### 4. UI: gutter theme + toolbar buttons

**Gutter styling** — extend `themeFor()` (`code-editor.tsx:46-81`) with fold-marker colors matching the existing gutter/cursor/selection entries:

```ts
'.cm-foldGutter .cm-gutterElement': {
  color: 'var(--muted-foreground)',
},
'.cm-foldPlaceholder': {
  backgroundColor: 'var(--muted)',
  color: 'var(--muted-foreground)',
  border: '1px solid var(--border)',
},
```

**Collapse All / Expand All** — two buttons in `files-tab.tsx`'s per-tab toolbar row (next to the existing Save/Discard buttons, `files-tab.tsx:225-234`), same `<Button size="xs" variant="outline">` styling:

```tsx
<Button size="xs" variant="outline" onClick={() => foldAll(tabView)}>Collapse All</Button>
<Button size="xs" variant="outline" onClick={() => unfoldAll(tabView)}>Expand All</Button>
```

using `foldAll`/`unfoldAll` from `@codemirror/language`, dispatched against the active tab's `EditorView`. `files-tab.tsx` already holds that view (via `setTabView`, passed into `CodeEditor`'s `onReady`), so no new prop or API surface on `CodeEditor` is needed.

### 5. Fold state persistence

No new code. `files-tab.tsx` already keeps every open tab's `EditorPanel` mounted simultaneously (hidden via CSS on switch, not destroyed — see the comment at `files-tab.tsx:256-258`), so each tab's `EditorView`, and the fold state CodeMirror tracks inside it, survives a tab switch automatically. Closing a tab (unmounting) still resets fold state on reopen — same lifecycle as cursor position and undo history today.

---

## Testing

- **`code-editor.test.tsx`** (existing file, Jest + Testing Library): fold markers render for a JSON file with a nested object; a `.yaml` file gets real syntax highlighting rather than falling into the plain-text path (regression check for the new language registration).
- **`markdown-frontmatter-fold.test.ts`** (new, unit): `frontmatterFoldRange` — valid frontmatter returns the correct range; a `---` appearing only later in the body returns `null`; no closing `---` returns `null`; empty document returns `null`.
- **`files-tab.test.tsx`** (existing file, orchestration): Collapse All dispatches a fold-all effect on the active tab's view; Expand All reverses it; switching tabs and back preserves collapsed state.
- **New Playwright `@user-workflow` spec**: open a large JSON file, collapse a nested object via its gutter icon, confirm the fold placeholder renders and the collapsed lines leave the DOM; click Collapse All and confirm the whole document folds; click Expand All and confirm it's restored.

---

## Summary of file changes

- `ui/package.json` — add `@codemirror/lang-yaml`
- `ui/src/pages/workspaces/code-editor.tsx` — add `foldGutter()`/`codeFolding()` to extensions, register `yaml`/`yml` in `EXTENSION_LANGUAGE`, extend `themeFor()` with fold-marker colors, wire the frontmatter fold extension into Markdown
- `ui/src/pages/workspaces/markdown-frontmatter-fold.ts` — new file, frontmatter fold logic
- `ui/src/pages/workspaces/markdown-frontmatter-fold.test.ts` — new unit tests
- `ui/src/pages/workspaces/files-tab.tsx` — add Collapse All / Expand All buttons to the per-tab toolbar
- `ui/test/code-editor.test.tsx`, `ui/test/files-tab.test.tsx` — additions per Testing section above
- `e2e/` — new `@user-workflow` spec per Testing section above
