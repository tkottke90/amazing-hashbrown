# Docs Site (11ty + Nunjucks) — Design

**Date:** 2026-09-09
**Status:** Approved

---

## Overview

The project needs user-facing documentation before it can be shared publicly. This introduces a static documentation site built with [11ty](https://www.11ty.dev/) (Eleventy) and Nunjucks templates, maintained as markdown files with YAML frontmatter for metadata. This pass establishes the site skeleton — two page layouts and the plumbing to build/serve them — not the finished content.

**Goals:**

- A new `docs-site` npm workspace producing a static site from markdown + frontmatter.
- Two layouts: an empty **front page** shell, and a **documentation library** page with a sidebar grouped by section.
- Content authoring should require no more than writing a markdown file with frontmatter — no manual nav-file editing per page.
- Visual style consistent with the main app's design system (Tailwind v4, blue/night-shadz palette).
- Buildable locally now; not painted into a corner for GitHub Pages later.

**Explicitly out of scope for this pass:**

- Migrating existing `docs/App-Docs/*.md` content into the site (kept as internal/dev-facing docs for now).
- Real content for the front page (stays blank).
- Site search.
- The actual GitHub Pages deploy workflow (`.github/workflows/...`).
- Dark mode toggle.

---

## Repository & Workspace Setup

- New workspace directory: `docs-site/`, added to the root `package.json` `workspaces` array.
- Root `package.json` gains:
  - `dev:docs` — runs the 11ty dev server for `docs-site`.
  - `docs-site`'s build folded into the top-level `build` script.
- `docs-site/package.json` scripts:
  - `dev` — runs the Tailwind CLI in watch mode and `eleventy --serve` concurrently.
  - `build` — runs the Tailwind CLI once, then `eleventy`.
- Dependencies: `@11ty/eleventy`, `@11ty/eleventy-plugin-syntaxhighlight`, `tailwindcss` v4, `@tailwindcss/cli`, `@tailwindcss/typography`.

### GitHub Pages readiness

11ty's `pathPrefix` config option is set (via env var or config) so generated links resolve correctly when the site is served from `https://<user>.github.io/amazing-hashbrown/` in the future. No Actions workflow is written yet — this is just making sure the 11ty config and templates use 11ty's URL-building helpers (`url` filter) rather than hardcoded absolute paths, so adding the workflow later is a non-breaking change.

---

## Content Model

- New directory: `docs-site/content/`. Existing `docs/App-Docs/` and `docs/Design/` are untouched — they remain internal design/dev documentation, not the source for this site.
- Doc pages live under `docs-site/content/docs/**/*.md`. Each has frontmatter:

  ```yaml
  ---
  title: 'Configuration'
  section: 'Getting Started'
  order: 1
  ---
  ```

  - `title` — page title, used in the sidebar link and `<title>`.
  - `section` — the sidebar group this page belongs to. Pages without a `section` fall into an "Uncategorized" group, rendered last, so a missing field never breaks the build.
  - `order` — sort position within its section. Pages without `order` sort after ordered ones, alphabetically by `title` as a tiebreaker (also the tiebreaker for equal `order` values).

- The front page is `docs-site/content/index.md` (or `.njk`), using the `home` layout. It does not carry `section`/`order` and is excluded from the sidebar collection.

- An 11ty collection (defined in `.eleventy.js` via `eleventyConfig.addCollection`) builds a `section -> [pages]` map once at build time by reading frontmatter off everything in `content/docs/`. This map is what both the sidebar template and any future "all docs" index consume — there is no separate nav config file to keep in sync.

---

## Layouts

Located in `docs-site/content/_includes/`.

- **`base.njk`** — shared HTML shell only: `<html>`, `<head>` (title block + stylesheet link), `<body>` block. No header or nav baked in, since the two layouts that extend it need different wayfinding (or none).

- **`home.njk`** (extends `base.njk`) — the front page. Per design decision, this stays a truly empty page: no header, no nav, just the shell. Ready for real content in a future pass.

- **`doc.njk`** (extends `base.njk`) — the documentation library page:
  - A header with the site title and a link back to `/`.
  - A `<nav>` sidebar rendering the `section -> [pages]` collection: section names as group headers, pages listed under each in `order`, current page highlighted by URL match.
  - A main content region rendering the rendered markdown body (`{{ content | safe }}`).

---

## Styling

- Tailwind v4, built via the standalone `@tailwindcss/cli` (11ty has no bundler of its own, unlike the `ui` workspace's Vite setup, so the CLI is the natural fit) watching `content/**/*.njk` and `content/**/*.md` for class usage. Output compiles to a CSS file 11ty passes through untouched (e.g. `content/_includes/css/site.css` → `_site/css/site.css`).
- `docs-site` defines its own `@theme` block, porting **only** the color tokens needed (the `blue-*` and `night-shadz-*` scales, plus the semantic tokens built from them) from `ui/src/style.css`. This is a one-time copy, not a shared import — `ui`'s stylesheet also pulls in shadcn/Radix/component tokens the docs site has no use for. A future palette change in `ui` will need to be manually ported here too; that tradeoff is accepted for simplicity.
- Markdown prose is styled with `@tailwindcss/typography`'s `prose` class on the doc-page content region, matching how the main UI already renders long-form markdown (chat messages) — avoids hand-styling every heading/paragraph/list/code element.
- Code blocks are highlighted at build time via `@11ty/eleventy-plugin-syntaxhighlight` (Prism-based, no client-side JS), since docs content is expected to include YAML/TypeScript snippets.

---

## Testing / Validation

- `npm run build --workspace docs-site` must produce a `_site/` directory with the front page and at least one seeded doc page (used to validate the sidebar grouping/ordering logic) without errors.
- Manual check in a browser: front page renders blank/shell-only; a doc page renders with sidebar grouped and ordered correctly, current page highlighted.
- No automated test suite for this pass — the site has no application logic beyond 11ty's own collection/templating, which is straightforward to eyeball-verify against the seeded pages.

---

## Follow-up work (not this pass)

- Migrate or link `docs/App-Docs/*.md` content into `docs-site/content/docs/`.
- Front-page real content.
- GitHub Pages Actions workflow.
- Site search.
- Dark mode.
