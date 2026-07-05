# AGENTS.md — ui

Preact + Vite frontend for the local LLM agent harness. TypeScript, styled
with Tailwind CSS v4 (`@tailwindcss/vite` plugin, imported in `src/style.css`
via `@import 'tailwindcss'`).

See the root `AGENTS.md` for repo-wide conventions and the required
pre-commit checks.

## Layout

```
src/
  components/
    ui/         shadcn/ui components (generated, see below)
  lib/
    utils.ts    cn() helper (clsx + tailwind-merge)
  pages/        Top-level views
  hooks/        Preact hooks
  services/     API client code (fetches against /api/v1/*)
  app.tsx       Root component
  index.tsx     Entry point — mounts <App /> and imports style.css
  style.css     Tailwind entry point
test/           Jest + @testing-library/preact tests
public/         Static assets copied as-is into the Vite build output
```

## shadcn/ui + Radix on Preact

Component UI is built with [shadcn/ui](https://ui.shadcn.com) (Radix
primitives) and icons come from `lucide-preact`. shadcn's CLI generates React
code, so this project aliases `react` / `react-dom` / `react/jsx-runtime` to
`preact/compat`, and `lucide-react` to `lucide-preact`, in both
`vite.config.ts` (runtime) and `tsconfig.json` (`compilerOptions.paths`, for
types). Generated components still say `import * as React from "react"` and
`import { X } from "lucide-react"` — leave those imports as-is, the aliases
resolve them to the Preact equivalents.

To add another component, run from `ui/` (the bundled CLI conflicts with the
repo's root `zod` override, so invoke it from outside the workspace tree and
point `--cwd` back here):

```sh
cd /tmp && npx shadcn@latest add <component> -y --cwd /path/to/repo/ui
```

Then run `npx prettier --write src/components/ui/<component>.tsx` — the CLI
emits double-quote/no-semicolon style that doesn't match this repo's
Prettier config — and typecheck/build to confirm it compiles cleanly against
Preact's stricter JSX types (the `asChild`/`Slot` polymorphic pattern, as
used in `button.tsx`, may need an `as React.ElementType<...>` cast).

## Talking to the API

The Vite dev server proxies `/api` to `http://localhost:3000` (see
`vite.config.ts`), so `fetch('/api/v1/...')` works the same in dev and in the
built app. Backend routes are versioned under `/api/v1` — see `api/AGENT.md`.

## Styling

Use Tailwind utility classes directly in components (`className="..."`, not
`class`). Avoid hand-written CSS files unless a utility genuinely can't
express what you need.

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

Tests, linting, and style checks must all pass — see the root `AGENTS.md`
checklist. For changes scoped to `ui/`, at minimum run `npm test` here and
`npm run lint` from the repo root before committing. For UI-visible changes,
also run `npm run dev` and check the change in a browser before committing.

## State Management

Prefer `@preact/signals` (`useSignal`, `useComputed`) over `useState`/`useReducer`
from `preact/hooks` for component-level reactive state.
