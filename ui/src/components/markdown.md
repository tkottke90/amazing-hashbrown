# Markdown

Renders a Markdown string as formatted HTML using `react-markdown` with GitHub Flavored Markdown support and syntax-highlighted code blocks. Fenced code blocks include a hover-activated copy button and a language label.

## Exports

| Export          | Type      | Description           |
| --------------- | --------- | --------------------- |
| `Markdown`      | Component | The Markdown renderer |
| `MarkdownProps` | Interface | Props for `Markdown`  |

## `Markdown`

### Props

| Prop        | Type     | Default | Description                                    |
| ----------- | -------- | ------- | ---------------------------------------------- |
| `children`  | `string` | —       | The Markdown source to render.                 |
| `className` | `string` | —       | Extra classes merged onto the `prose` wrapper. |

### Basic usage

```tsx
import { Markdown } from '@/components/markdown';

<Markdown>{'# Hello\n\nThis is **bold** and `inline code`.'}</Markdown>;
```

### With additional prose classes

```tsx
<Markdown className="prose-lg">{longFormContent}</Markdown>
```

## Styling

The wrapper div carries `prose prose-sm dark:prose-invert max-w-none` from `@tailwindcss/typography`. Extra classes passed via `className` are merged in.

- `prose-sm` matches the app's 14 px base font size.
- `max-w-none` removes the typography plugin's default width cap so the component fills its container.
- `dark:prose-invert` applies dark-mode typography colors automatically when the `.dark` class is present on any ancestor element.

## Supported Markdown features

- All standard CommonMark (headings, paragraphs, lists, blockquotes, links, images, inline code, bold, italic, etc.)
- **GitHub Flavored Markdown** via `remark-gfm`: tables, task lists, strikethrough, autolinks
- **Fenced code blocks** with syntax highlighting via `rehype-highlight` (highlight.js token classes)
- **Inline SVG**: a raw `<svg>...</svg>` block written directly in Markdown source renders as real SVG. See "Inline SVG" below.

## Code blocks

Code blocks are wrapped in a custom `CodeBlock` component that:

- Applies highlight.js syntax highlighting via the `language-*` class written by `rehype-highlight`.
- Shows a **language label** (e.g. `typescript`) in the top-right corner of the block when the language is specified in the fence.
- Shows a **Copy** icon button that copies the block's plain text to the clipboard. After a successful copy the icon changes to **Check** for 2 seconds, then resets.
- The label and button are hidden by default and appear on hover (`group-hover:opacity-100`).
- Preserves the block's exact whitespace (indentation included), both on screen and when copied — important for whitespace-sensitive content like YAML.

### Long lines: scroll vs. wrap

How a line longer than the block's width is handled is controlled by the
**"Wrap long lines in code blocks"** setting (Settings → Agent behavior),
read from the global `codeBlockWrap` signal in
`@/hooks/use-chat-display-settings`:

- **Off (default):** the block scrolls horizontally (`overflow-x-auto`);
  whitespace is preserved exactly (`whitespace-pre`).
- **On:** the line wraps at the block's edge instead of scrolling
  (`whitespace-pre-wrap`), with `break-words` guarding against a single
  unbroken long token forcing overflow.

### Specifying a language

````md
```typescript
const greet = (name: string) => `Hello, ${name}!`;
```
````

### Code block without a language

````md
```
plain text block — no highlighting, no language label
```
````

## Links

Absolute `http://`/`https://` links open in a new tab (`target="_blank" rel="noopener noreferrer"`) so clicking a link in a chat message or wiki page doesn't navigate the current tab away from the app. Relative links (e.g. in-app wiki navigation links), `mailto:`, `tel:`, and anchor (`#...`) links are left unchanged — same tab, no `rel`.

## Inline SVG

A raw `<svg>...</svg>` block written directly in Markdown source renders as real SVG, in both consumers of this component (chat bubbles and the wiki page preview). Two mechanisms work together — see `GLOSSARY.md`'s "Markdown Rendering & Inline SVG" section, ADR-0071, and ADR-0072 for the full rationale, not repeated here:

- **Markdown Sanitize Schema** (`src/lib/markdown-sanitize-schema.ts`) — an explicit allowlist of exactly which SVG tags/attributes survive. Not every SVG element is supported; `<script>`, `<iframe>`, `<image>`, `<foreignObject>`, `on*` handlers, and any externally-resolving URL (not just `javascript:`) are stripped. SMIL animation (`animate`/`animateTransform`/`animateMotion`/`set`) is allowed with no duration/repeat-count enforcement — an accepted, undefended risk.
- **SVG Sandbox** (`svg-sandbox.tsx`) — every rendered SVG is mounted inside a custom element with its own open Shadow DOM, uniformly (not only ones using `<style>`). This is what lets `<style>` be allowed at all (genuinely CSS-scoped to that SVG, not page-wide) and lets `<use href="#id">` internal references resolve.

Known limitations: an SVG's authored colors render as-is, identically in light and dark mode (no color adaptation); oversized SVGs are capped to their container's width via a stylesheet the Sandbox injects into its own shadow root, since the normal `prose`/Tailwind cascade can't reach across the shadow boundary.

## Themes

Syntax highlighting uses the [github](https://highlightjs.org/) highlight.js theme in light mode and a matching github-dark palette in dark mode. The theme switches automatically with the `.dark` class — no extra configuration needed.

The light-mode code block background is `#f6f8fa` (GitHub's standard code surface color) to distinguish it from the white page background. The dark-mode background is `#0d1117`.

## Dependencies

| Package                   | Role                                                  |
| ------------------------- | ----------------------------------------------------- |
| `react-markdown`          | Markdown → JSX renderer                               |
| `remark-gfm`              | GitHub Flavored Markdown parser plugin                |
| `rehype-raw`              | Parses raw HTML in Markdown source (incl. SVG)        |
| `rehype-sanitize`         | Enforces the Markdown Sanitize Schema on the tree     |
| `rehype-highlight`        | Syntax highlighting (adds highlight.js token classes) |
| `highlight.js`            | Token class definitions and CSS theme                 |
| `@tailwindcss/typography` | `prose` utility class                                 |
| `@preact/signals`         | `useSignal` for the copy-button state                 |
