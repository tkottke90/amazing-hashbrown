# SVG Dashboard Widget — Design

**Date:** 2026-11-26
**Issue:** #426 (depends on #425, already landed)
**Scope:** `lib/amazing-hashbrown-widgets`, `api/` dashboard handlers + widget-content agent tool, `ui/src/pages/dashboard`, `ui/src/lib/markdown-sanitize-schema.ts`, `ui/src/components/svg-sandbox.tsx`

Terms in this document (SVG Widget, SVG Source, SVG Sandbox, Markdown Sanitize Schema, Widget Body, Widget Payload) are defined in `GLOSSARY.md`. Sanitize policy and Shadow-DOM isolation are decided in ADR-0071 and ADR-0072; per-type persistence follows ADR-0002.

## Problem

Dashboard widgets are a closed union (`markdown`, `big-number`, `line-graph`, `pie-graph`, `system`, `spacer`). The only way to put an SVG on a board is inside a Markdown widget's prose. There is no widget whose whole purpose is a drawing.

## Goal

Add an `svg` widget type, sibling to the existing six, whose Widget Body is the SVG Source and whose card renders it sanitized, inside the SVG Sandbox, scaled to fit the card.

## Non-goals

- No generic "custom content" widget or `meta`/`config` bag (AGENTS.md: composition over customization).
- No live preview in the drawer; it is a plain `Textarea` like `markdown`.
- No new ADR. Nothing here is surprising relative to ADR-0002/0071/0072.
- No change to the Markdown render pipeline's behaviour.

## Design

### 1. Widget type (`lib/amazing-hashbrown-widgets`)

- `types.ts`: add `SvgWidget` (`type: 'svg'`, `content: string`, shaped like `MarkdownWidget`) to `DashboardWidget`, `WidgetContentInput`, `WritableDashboardWidget`, `WidgetPersistInput`.
- `internal/widget-field-schemas.ts`: add `SvgWidgetFrontmatterSchema` to `WidgetFrontmatterSchema`'s discriminated union and `DashboardWidgetSchema`; add `svg: { w: 3, h: 2 }` to `WIDGET_SIZE_MIN` (same floor as `markdown`). The `Record` keyed by type literals makes the compiler enumerate every other consumer.
- `store.ts`: create/update/read treat `svg` exactly like `markdown` (frontmatter + body split); only the type literal differs. No special-casing.
- Persistence shape: frontmatter scalars shared by all widgets, SVG Source as the body (ADR-0002).

### 2. Sanitize schema reuse (`ui/src/lib/markdown-sanitize-schema.ts`)

`markdownSanitizeSchema` is Markdown-flavored (`p`, `h1`–`h6`, `a`, `img`, `input`, `span`). Using it unchanged would let a non-SVG node render at the top of an SVG Widget. Instead:

- Export the SVG subset from the same file: the `svg` root entry, `SVG_ANCESTOR_TAGS` and their `attributes` entries, the `ancestors` map, and the `clobber` setting.
- Derive both schemas from those shared constants: `markdownSanitizeSchema` = Markdown tags + SVG subset (behaviour unchanged); `svgSanitizeSchema` = SVG subset only.
- No `svg-sanitize-schema.ts` file; #425 already placed the shared schema in `lib/`. One enumeration, two compositions.
- All ADR-0071 rules carry over to both consumers: `script`/`iframe`/`on*`/`foreignObject` absent, `href`/`xlink:href` on `use` and SMIL elements restricted to `#fragment`, `<style>` only with an `svg` ancestor.

### 3. SVG Source validity

Valid means: after parse (`hast-util-from-html`, fragment mode) and sanitize with `svgSanitizeSchema`, the result is **exactly one root `<svg>` element** with no sibling elements or non-whitespace text. Anything else is invalid.

Put the check in one pure function (e.g. `parseSvgSource(source): { ok: true; tree } | { ok: false }`) in `ui/src/lib/`, so the card and its tests share it.

### 4. Rendering (`ui/src/pages/dashboard/svg-widget.tsx`)

- Copy `markdown-widget.tsx`'s composition (`WidgetCard`/`WidgetHeader`/`WidgetContent`/`WidgetAction`/`WidgetFooter`/`WidgetDrawer`/`WidgetCopyTargetButton`), swapping the `<Markdown>` child.
- Render does **not** go through `react-markdown`/`remark-gfm`/`rehype-highlight`. It parses and sanitizes directly (§3), converts the hast tree to Preact elements, and mounts it in `SvgSandbox`.
- Invalid SVG Source renders an inline "Invalid SVG" state inside `WidgetContent`. `WidgetErrorCard` stays reserved for widget-load failures. The stored body is never modified.
- Sizing: SVG fits the card, centered, aspect ratio preserved, no overflow or scroll. `SvgSandbox`'s current host rule (`:host svg { max-width: 100%; height: auto }`) is Markdown-flow sizing, so `SvgSandbox` gains a small variant/prop (e.g. `fit="card"`) that injects a fit-to-container host style (`width: 100%; height: 100%`, SVG default `preserveAspectRatio` meet). Default behaviour for Markdown is unchanged.
- `widget-renderer.tsx`: add the `svg` case wired to `SvgWidget` with `WIDGET_SIZE_MIN.svg`.

### 5. Drawer (`widget-drawer.tsx`)

Add `svg` to the type selector and thread it through the same four touch points `markdown` has (edit defaults, submit payload, form fields, serialization — also `serialize-widget-file.ts`). The field is a raw-SVG `Textarea`, same pattern as `markdown`.

### 6. API and agent writes

- `api/src/routes/v1/dashboards.handlers.ts`: create/update accept `{ type: 'svg', title, subtitle?, content }` through the same handlers as other types.
- **Write-time check:** reject a body that is not a single `<svg>…</svg>` with a 400. This is a cheap structural check only (trimmed source starts with `<svg` and ends with `</svg>`); it is not a second sanitizer. Sanitization stays client-side and the renderer remains the security boundary, as with Markdown.
- `update_dashboard_widget_content` (`api/src/agents/tools/update-widget-content.tool.ts`) accepts `svg` payloads under the same structural check. The copy-target button (Dashboard Widget Target Snippet) is offered for `svg` as for `markdown`.

## Testing

Per AGENTS.md, all new code ships with tests (tags per the repo's `TestTypes`).

- **Store** (`lib/amazing-hashbrown-widgets/test/store.test.ts`): create/read/update round-trip for `svg` [unit].
- **Schema** (`frontmatter.test.ts`): `SvgWidgetFrontmatterSchema` accepts valid, rejects below-minimum `w`/`h` [unit].
- **Sanitize matrix**: call the real `unified().use(rehypeRaw)`/sanitize pipeline directly (the Jest `react-markdown` mock cannot exercise stripping — ADR-0072 Consequences). Cover `<script>`, `<iframe>`, `on*`, `javascript:` URLs, `foreignObject`, external `href` on `<use>`/`<image>`; run against `svgSanitizeSchema` and confirm `markdownSanitizeSchema` behaviour is unchanged after the refactor [unit].
- **`parseSvgSource`**: single root ok; text-only, two roots, leading prose, empty, and a body that sanitizes away to nothing are invalid [unit].
- **Renderer dispatch** (`dashboard-widget-renderer.test.tsx`): `svg` routes to `SvgWidget` with the right min size [orchestration].
- **`SvgWidget`**: valid renders in a sandbox; invalid shows the inline state and does not throw [unit].
- **Drawer**: create and edit an `svg` widget [unit].
- **API handlers / agent tool**: accept valid SVG, 400 on non-SVG body [unit], extending `dashboards.handlers.test.ts` and `update-widget-content.tool.test.ts`.
- **E2E** (`e2e/tests/dashboard.spec.ts`, `@user-workflow`, CI-safe): user adds an SVG widget via the drawer and sees it render; pasted garbage shows the "Invalid SVG" state without breaking the dashboard; Shadow-DOM style isolation (a `<style>` in the SVG does not restyle the page) is checked here, since Jest cannot.

## Risks / notes

- Hast-to-Preact conversion: `ui/package.json` has `rehype-raw` but no direct hast-to-JSX dependency, and `node_modules` was not installed when this was written, so whether `hast-util-to-jsx-runtime` (a likely transitive dependency of `react-markdown`) is usable is unverified. Confirm during implementation; adding it as a direct dependency is acceptable, and so is a small hand-written hast walker.
- Raising `WIDGET_SIZE_MIN` is not involved (new type), so ADR-0044's clamping does not apply.
