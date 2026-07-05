# AGENTS.md

Instructions for agents (and humans) working in this repository.

## What this is

`amazing-hashbrown` is a local LLM agent harness: a persona knowledge base and
autonomous assistant. It's an npm-workspaces monorepo with two apps:

- `api/` — Express REST API, LangChain agents, knowledge base (see `api/AGENTS.md`)
- `ui/` — Preact web frontend (see `ui/AGENTS.md`)

Read the `AGENTS.md` in whichever workspace you're changing before making
edits there — it has directory-specific conventions this file doesn't repeat.

## Stack

TypeScript everywhere, npm workspaces, ESLint + Prettier (shared root config),
Node.js 20+ (Docker image targets `node:24`).

## Setup

```sh
npm install
cp .env.example .env
```

## Common commands (run from repo root)

```sh
npm run dev:api     # start the API in watch mode
npm run dev:ui       # start the Vite dev server (proxies /api to the API)
npm run build        # build both workspaces
npm test             # run api (Mocha) and ui (Jest) test suites
npm run lint          # ESLint across the whole repo
npm run format        # Prettier --write across the whole repo
```

There is no per-workspace lint/format script — ESLint and Prettier are
configured once at the repo root (`eslint.config.js`, `.prettierrc.json`) and
apply to both `api/` and `ui/`.

## Before committing

**Tests, linting, and style checks must all pass before you make a commit.**
Run, from the repo root:

```sh
npm run lint
npx prettier --check .
npm test
```

If any of these fail, fix the issue before committing — don't commit with
`--no-verify` or otherwise bypass the check.

## CI

`.github/workflows/` runs the same three checks (`tests.yml`, `lint.yml`,
`style.yml`) whenever a PR is opened, reopened, or updated with new commits,
each in its own job. They should always be green if you ran the pre-commit
checks above locally.

## Docker

The root `Dockerfile` is a multi-stage `node:24` build: it compiles both
workspaces, installs production-only dependencies (`npm ci --omit dev`), and
assembles a runtime image that serves the built `ui` app as static files from
the `api` server. See `api/AGENTS.md` for how static hosting is wired up.

## UI State Management

The `ui/` workspace uses `@preact/signals` for component state. Prefer
`useSignal`/`useComputed` over `useState`/`useReducer`. See `ui/AGENTS.md`
for details.
