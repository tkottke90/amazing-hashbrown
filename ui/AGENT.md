# AGENT.md — ui

Preact + Vite frontend for the local LLM agent harness. TypeScript, styled
with Tailwind CSS v4 (`@tailwindcss/vite` plugin, imported in `src/style.css`
via `@import 'tailwindcss'`).

See the root `AGENT.md` for repo-wide conventions and the required
pre-commit checks.

## Layout

```
src/
  components/   Reusable UI components
  pages/        Top-level views
  hooks/        Preact hooks
  services/     API client code (fetches against /api/v1/*)
  app.tsx       Root component
  index.tsx     Entry point — mounts <App /> and imports style.css
  style.css     Tailwind entry point
test/           Jest + @testing-library/preact tests
public/         Static assets copied as-is into the Vite build output
```

## Talking to the API

The Vite dev server proxies `/api` to `http://localhost:3000` (see
`vite.config.ts`), so `fetch('/api/v1/...')` works the same in dev and in the
built app. Backend routes are versioned under `/api/v1` — see `api/AGENT.md`.

## Styling

Use Tailwind utility classes directly in components (`class="..."`, not
`className`, since this is Preact). Avoid hand-written CSS files unless a
utility genuinely can't express what you need.

## Commands (run from `ui/`, or with `--workspace ui` from the repo root)

```sh
npm run dev       # vite dev server on :5173
npm run build     # tsc typecheck, then vite build -> dist/
npm run preview   # preview the production build locally
npm test          # jest (test/**/*.test.tsx)
```

Linting and formatting are configured at the repo root — run `npm run lint`
/ `npx prettier --check .` from the repo root, not from `ui/`.

## Before committing

Tests, linting, and style checks must all pass — see the root `AGENT.md`
checklist. For changes scoped to `ui/`, at minimum run `npm test` here and
`npm run lint` from the repo root before committing. For UI-visible changes,
also run `npm run dev` and check the change in a browser before committing.
