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

## Code blocks

Code blocks are wrapped in a custom `CodeBlock` component that:

- Applies highlight.js syntax highlighting via the `language-*` class written by `rehype-highlight`.
- Shows a **language label** (e.g. `typescript`) in the top-right corner of the block when the language is specified in the fence.
- Shows a **Copy** icon button that copies the block's plain text to the clipboard. After a successful copy the icon changes to **Check** for 2 seconds, then resets.
- The label and button are hidden by default and appear on hover (`group-hover:opacity-100`).

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

## Themes

Syntax highlighting uses the [github](https://highlightjs.org/) highlight.js theme in light mode and a matching github-dark palette in dark mode. The theme switches automatically with the `.dark` class — no extra configuration needed.

The light-mode code block background is `#f6f8fa` (GitHub's standard code surface color) to distinguish it from the white page background. The dark-mode background is `#0d1117`.

## Dependencies

| Package                   | Role                                                  |
| ------------------------- | ----------------------------------------------------- |
| `react-markdown`          | Markdown → JSX renderer                               |
| `remark-gfm`              | GitHub Flavored Markdown parser plugin                |
| `rehype-highlight`        | Syntax highlighting (adds highlight.js token classes) |
| `highlight.js`            | Token class definitions and CSS theme                 |
| `@tailwindcss/typography` | `prose` utility class                                 |
| `@preact/signals`         | `useSignal` for the copy-button state                 |
