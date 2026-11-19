# Inline SVG Rendering in Markdown — Design

**Date:** 2026-11-19
**Status:** Approved
**Issue:** [#425 — Render inline SVG in Markdown (chat bubbles + wiki page preview)](https://github.com/tkottke90/amazing-hashbrown/issues/425)

Domain terms used below (**Markdown Sanitize Schema**, **SVG Sandbox**) are defined in `GLOSSARY.md`'s "Markdown Rendering & Inline SVG" section. The two architectural decisions this design rests on are recorded as ADR-0071 and ADR-0072 and are not restated here.

---

## 1. Problem

`Markdown` (`ui/src/components/markdown.tsx`) renders via `react-markdown` with `remark-gfm` and `rehype-highlight` only — no raw-HTML parsing. An `<svg>...</svg>` block written directly in Markdown source is escaped as literal text, in both consumers of the shared component: chat bubbles (`chat-message.tsx`/`assistant-message.tsx`) and the wiki page preview (`document-view.tsx`). There is no way to show an inline diagram/icon/chart authored directly as SVG markup in either surface.

## 2. Markdown Sanitize Schema (ADR-0071)

New module `ui/src/lib/markdown-sanitize-schema.ts`, exporting a `hast-util-sanitize`-shaped `Schema` object consumed by `rehype-sanitize`. Built by explicit enumeration (ADR-0071), not `defaultSchema` inheritance:

- **Base tags**: every tag the current pipeline already legitimately produces — CommonMark (`p, h1-h6, hr, blockquote, pre, code, a, img, em, strong, ul, ol, li, br`), GFM (`del, table, thead, tbody, tr, th, td, input[type=checkbox]`), and `rehype-highlight`'s injected `span` (with `className` allowed, matching the existing `code` entry's `/^language-./`-style scoped allowance — see §4 for why no `hljs-*`-specific regex is needed).
- **SVG tags added**: `svg` (the root — no ancestor restriction, it's the thing being required of everything else) plus `path, circle, rect, ellipse, line, polyline, polygon, g, defs, use, symbol, text, tspan, title, desc, clipPath, mask, linearGradient, radialGradient, stop, marker, animate, animateTransform, animateMotion, set`. Every one of _those_ (everything except `svg` itself) gets `ancestors: ['svg']` — an orphan `<path>` typed outside any `<svg>` wrapper strips rather than rendering as a meaningless element. `hast-util-sanitize`'s `ancestors` check walks the full tag-name stack, so nesting through `<defs>`/`<linearGradient>` etc. still resolves.
- **Explicitly excluded, no exceptions**: `style` (element), `image`, `foreignObject`, `script`, `iframe`, and any `on*` attribute (the last two already excluded by `defaultSchema`'s own absence of them — kept out of this schema too, by construction of only ever adding what's listed above). `style` is the one tag allowed _conditionally_ — see §3; it is not in this base schema's unconditional tag list.
- **Attribute casing**: schema keys are hast _property names_ (camelCase), not raw SVG attribute spelling — `stroke-width` → `strokeWidth`, `fill-opacity` → `fillOpacity`, `stroke-dasharray` → `strokeDashArray`, `stroke-linecap` → `strokeLineCap`, `stroke-linejoin` → `strokeLineJoin`, `font-size` → `fontSize`, `font-family` → `fontFamily`, `stop-color` → `stopColor`, `stop-opacity` → `stopOpacity`, `text-anchor` → `textAnchor`, `clip-path` → `clipPath`, `class` → `className`. Using the hyphenated spelling directly is a silent no-op. Everything else on the agreed attribute list (`d, fill, stroke, viewBox, width, height, transform, x, y, cx, cy, r, rx, ry, points, x1, y1, x2, y2, offset, gradientUnits, gradientTransform, opacity, preserveAspectRatio, xmlns, id`) is already single-word and needs no mapping.
- **`href`/`xlink:href`**: allowed only on `use` and the animation elements (for internal retargeting), with `protocols: { href: [] }` (empty array — only local/fragment URLs survive, no scheme at all). `<a>` is the one carve-out: its `href` keeps the base schema's ordinary external-link protocol list, unchanged from how a plain Markdown link already works — a click is an explicit user action, unlike `<image>`/`<use>`/animation elements auto-resolving on render.
- **`image` stays excluded entirely** — no internal-only use case exists for it (unlike `use`, which legitimately references `<defs>`/`<symbol>` within the same document), so the blanket external-fetch concern applies with no carve-out.
- **`clobber`/`clobberPrefix`**: overridden from `defaultSchema`'s defaults to drop `id`/`name` from `clobber` (equivalently, `clobberPrefix: ''`) — see ADR-0072 for why this is safe once every SVG is Sandbox-mounted.
- **Animation value bounds**: none enforced. `animate`/`animateTransform`/`animateMotion`/`set` are structurally allowed with no duration/repeat-count capping — a schema can only allow/deny tags and attributes, not validate values; capping would need a separate rehype plugin pass, not built here (ADR-0071).

## 3. SVG Sandbox (ADR-0072)

New component `ui/src/components/svg-sandbox.tsx`:

- A custom element, registered once at module load (`customElements.define('markdown-svg-sandbox', ...)` if not already defined), whose `connectedCallback` calls `this.attachShadow({ mode: 'open' })` and injects one developer-authored `<style>` into the shadow root: `:host svg { max-width: 100%; height: auto; }` — reproducing the intended responsive-sizing behavior (§5) that the normal Tailwind/`prose` cascade can no longer reach once content is shadow-scoped.
- An `SvgSandbox` Preact component wraps the custom element: it renders `<markdown-svg-sandbox ref={...} />`, and once mounted, uses `preact/compat`'s `createPortal(props.children, hostRef.current.shadowRoot)` to project the already-rendered SVG subtree into the shadow root.
- `markdownComponents` (`markdown.tsx`) gains an `svg: (props) => <SvgSandbox {...props} />` entry alongside the existing `pre`/`img`/`a` overrides. Because react-markdown's per-node dispatch builds the entire subtree (including any nested `a` via `MarkdownLink`) _before_ handing it to this override, every existing override keeps working unchanged inside a Sandbox-mounted SVG — only the mount target changes.
- `<style>` is schema-allowed (§2) only with `ancestors: ['svg']` — reachable solely inside a Sandbox-mounted subtree, never at a Markdown message's top level.
- Applied uniformly: every rendered `<svg>` gets Sandbox-mounted, not conditionally based on whether it contains `<style>`.

## 4. Pipeline order

```ts
rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeHighlight];
```

`rehypeRaw` must run before `rehypeSanitize` — an unexpanded `raw` hast node (what `remark-rehype` leaves for embedded HTML strings) isn't one of the node types `hast-util-sanitize`'s `transform()` recognizes and is silently dropped if sanitize runs first. Running `rehypeHighlight` _last_, after sanitize, means its injected `hljs-*` token `<span className>`s never pass through a sanitize pass at all — no need to allowlist highlight.js's internal class-naming scheme in the schema, and no risk of a future highlight.js theme change silently breaking under an outdated regex.

## 5. Sizing & theming

- Responsive sizing (`max-width: 100%; height: auto`, preserving the source's own aspect ratio) is delivered via the Sandbox's own `:host` stylesheet (§3), not a `prose` rule — it has to be, since Shadow DOM blocks the ambient cascade from reaching in.
- Dark-mode color adaptation is explicitly out of scope: an SVG's authored colors render as-is, identically in both themes. Known limitation, not a defect.
- No special "invalid SVG" fallback UI: `rehype-raw` sits on `parse5`, a WHATWG HTML5-compliant parser — malformed/unclosed markup recovers the same way a browser recovers (implicit closing, reparenting), never throws. Whatever that tolerant parse produces renders as-is.

## 6. Testing

Per ADR-0072's noted consequence, `ui/test/__mocks__/react-markdown.tsx` renders `children` into a plain `<div>` and ignores `components`/`rehypePlugins` entirely — neither the schema's stripping behavior nor the Sandbox's shadow-mounting can be exercised through `<Markdown>` in a Jest test that uses the existing mock.

- **`ui/test/markdown-sanitize-schema.test.ts`** (new, plain `.test.ts` — no Preact rendering): builds the real `unified().use(rehypeRaw).use([rehypeSanitize, markdownSanitizeSchema]).use(rehypeStringify)` pipeline directly against markdown-with-raw-HTML input strings and asserts on the output HTML string. Cases: a representative safe SVG (shapes, gradients, a `<use>` referencing an internal `<defs>`/`<symbol>` by `#id`) renders through intact; `<script>`, `<iframe>`, any `on*` attribute, a `javascript:`-scheme `href`, `foreignObject`, `<image>`, and an absolute-URL `href`/`xlink:href` on `use`/animation elements are all stripped; a plain Markdown `<a href="https://...">` (inside or outside SVG) keeps its external href; existing non-SVG Markdown (headings, GFM tables/task-lists, fenced code blocks with `rehype-highlight`'s `hljs-*` spans) still renders unchanged.
- **`ui/test/svg-sandbox.test.tsx`** (new): renders `SvgSandbox` directly via `@testing-library/preact` (bypassing the `react-markdown` mock entirely, since this is an ordinary Preact component) — asserts a shadow root is attached, `mode: 'open'`, and that `children` end up inside `hostElement.shadowRoot`, not in the light DOM.
- **`ui/test/markdown.test.tsx`** (existing): no new SVG-specific cases needed here — the mock makes them meaningless; existing cases (code block copy button, external link handling, image routing) are unaffected by this change.
- **E2E (Playwright, new or extended spec)**: a chat message / wiki page containing `<svg><style>...</style>...</svg>` renders real `<svg>` elements in devtools (not escaped text), identically in a chat bubble and the wiki preview; a sibling element outside the SVG is visually unaffected by the embedded `<style>`'s rules (confirms Shadow DOM's CSS isolation actually holds in a real browser, which Jest cannot verify); an oversized SVG (`width="2000"`) stays capped to its container's width.

## 7. Out of scope

- Animation duration/repeat-count enforcement (ADR-0071) — accepted, documented risk for this internal tool.
- Dark-mode color adaptation for author-supplied SVG colors (§5).
- Any raw-HTML sandboxing beyond the `<svg>` subtree — `<style>` and relaxed `clobber` protection apply only inside a Sandbox-mounted SVG, never elsewhere in a Markdown message.
- A polyfill/fallback for browsers without Shadow DOM support (ADR-0072).
- Issue #426 (a dedicated SVG dashboard widget) — depends on this design's Markdown Sanitize Schema being importable/reusable, but is tracked and scoped separately.

## 8. Files changed

| File                                                      | Change                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/lib/markdown-sanitize-schema.ts` (new)            | The Markdown Sanitize Schema (§2)                                                                                                                                           |
| `ui/src/components/svg-sandbox.tsx` (new)                 | Custom element + `SvgSandbox` Preact wrapper (§3)                                                                                                                           |
| `ui/src/components/markdown.tsx`                          | Add `rehypeRaw`/`rehypeSanitize` to `rehypePlugins` in the order in §4; add `svg` entry to `markdownComponents`                                                             |
| `ui/src/components/markdown.md`                           | Document SVG support, the Sanitize Schema/Sandbox split, and the new dependencies                                                                                           |
| `ui/package.json`                                         | Add `rehype-raw@7.0.0`, `rehype-sanitize@6.0.0`                                                                                                                             |
| `ui/jest.config.js`                                       | Add `rehype-raw`/`rehype-sanitize` to `moduleNameMapper`, pointing at `test/__mocks__/esm-plugin.tsx` (same no-op pattern already used for `remark-gfm`/`rehype-highlight`) |
| `ui/test/markdown-sanitize-schema.test.ts` (new)          | Schema correctness cases (§6)                                                                                                                                               |
| `ui/test/svg-sandbox.test.tsx` (new)                      | Shadow-mounting cases (§6)                                                                                                                                                  |
| `e2e/tests/*.spec.ts` (new or extended)                   | Chat/wiki SVG rendering + CSS-isolation cases (§6)                                                                                                                          |
| `GLOSSARY.md`, `docs/adr/0071-*.md`, `docs/adr/0072-*.md` | Already committed (domain-modeling pass)                                                                                                                                    |
