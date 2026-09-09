# Docs Site (11ty + Nunjucks) — Design

**Date:** 2026-09-09
**Status:** Approved

_Amended 2026-09-09: GitHub Pages deploy workflow moved in-scope (see "GitHub Pages Deploy Workflow" below)._

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

11ty's `pathPrefix` config is read from the `ELEVENTY_PATH_PREFIX` environment variable (defaulting to `/` for local dev/build), so generated links resolve correctly when the site is served from `https://<user>.github.io/amazing-hashbrown/`. Templates use 11ty's `url` filter rather than hardcoded absolute paths, so the deploy workflow can set the prefix without touching template source.

### GitHub Pages Deploy Workflow

- New workflow: `.github/workflows/deploy-docs.yml`, triggered **only** by `workflow_dispatch` (manual) — no `pull_request` or `push` trigger, since this is an early-stage docs site not ready for auto-publish on every merge.
- **Prerequisite (one-time, manual, cannot be done via code):** repo Settings → Pages → Source must be set to "GitHub Actions" before the workflow's `deploy` job can succeed.
- The build step runs `npm run build --workspace docs-site` only — the docs site has no runtime dependency on `api`/`ui`/`lib` build outputs, so the workflow does not run the monorepo's full `build` or `build:libs` scripts.
- Deploy artifact path is `docs-site/_site` (the 11ty build output directory), uploaded via `actions/upload-pages-artifact` and published via `actions/deploy-pages`, following GitHub's standard build/deploy job split with `permissions` scoped to the `deploy` job only (`pages: write`, `id-token: write`).
- `ELEVENTY_PATH_PREFIX` is set at build time from `actions/configure-pages`'s `base_path` output, so the deployed site's links resolve correctly without hardcoding the repo name in source.

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

- Tailwind v4, built via the standalone `@tailwindcss/cli` (11ty has no bundler of its own, unlike the `ui` workspace's Vite setup, so the CLI is the natural fit). Input file is `docs-site/src/tailwind.css` (Tailwind's automatic content detection scans `docs-site/content/**` for class usage since both live under the same workspace root); output compiles to `docs-site/content/css/site.css`, which 11ty passthrough-copies untouched to `_site/css/site.css`. The generated CSS file is gitignored, not committed.
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
- Site search.
- Dark mode.
