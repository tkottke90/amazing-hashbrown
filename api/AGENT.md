# AGENT.md — api

Express REST API for the local LLM agent harness. TypeScript, ESM
(`"type": "module"`, `NodeNext` module resolution — import local files with
explicit `.js` extensions).

See the root `AGENT.md` for repo-wide conventions and the required
pre-commit checks.

## Layout

```
src/
  agents/           LangChain agent/chain definitions and streaming chat handlers
  config/           env.ts (@tkottke90/config-manager, seeded from .env via
                     dotenv) and logger.ts (@tkottke90/logger)
  knowledge-base/   Domain-organized knowledge bases (LLM-Wiki pattern) — one
                     subfolder per domain under knowledge-base/domains/
  middleware/       Express middleware (request-logger.ts, etc.)
  routes/           Express routers. All backend routes are versioned and
                     nested under /api/v1 (routes/v1/*); app.ts mounts
                     routes/index.ts at /api
  types/            Shared API types + express.d.ts (module augmentation for
                     req.logger / app.logger)
  app.ts            Express app factory (routes + static hosting)
  index.ts          Server entrypoint — reads env.port, calls app.listen
test/               Mocha + Chai tests
public/             Static files served at the app root by express.static.
                     This checked-in copy is a dev-only placeholder; in the
                     Docker image it's replaced by the built ui app
```

## Adding a route

New routes go under `src/routes/v1/`, mounted onto `v1Router` in
`src/routes/v1/index.ts`. Don't add unversioned routes at `/api/*` directly —
everything hangs off `/api/v1` so future breaking changes can live at
`/api/v2` without disrupting existing clients.

## Environment and config

`src/config/env.ts` loads `.env` (see `.env.example`) via `dotenv`, then
passes those values as `runtimeValues` into `@tkottke90/config-manager`'s
`loadConfig`, validated against a Zod schema, with `writeBack: false` since
config here is driven by env vars/container config rather than a file on
disk. Read config through the exported `env` object — don't read
`process.env` directly elsewhere. Add new config fields to `AppConfigSchema`
in `env.ts` (with a `.default(...)`) rather than reading ad hoc env vars.

`app.ts` also assigns `app.config = env` (typed via `AppConfig`, exported
from `env.ts`, in the same `express.d.ts` augmentation as `app.logger`), so
route handlers can read config off the request as `req.app.config` instead
of importing `env` directly.

## Logging

`src/config/logger.ts` configures a shared `logger` via
`@tkottke90/logger`'s `configureFromSchema`, level driven by `env.logLevel`
(`LOG_LEVEL` env var). Use `logger` for anything outside a request (startup,
background jobs) instead of `console.log`/`console.error`.

`src/middleware/request-logger.ts` runs first in `app.ts` and, for every
request: generates a `reqId` (`crypto.randomUUID()`), creates a fresh
`logger.createChildLogger(route, { reqId })` and assigns it to `req.logger`
(typed via `src/types/express.d.ts`'s augmentation of
`express-serve-static-core`), and on the response's `close` event (fires once
the response is fully sent, including aborted requests — not `finish`) logs
method/URL/status plus `durationMs`, timed with `process.hrtime()` rather
than `Date.now()`. Inside a route handler or anything that receives `req`,
log through `req.logger` (not the top-level `logger`) so log lines carry the
request's id automatically.

Both `@tkottke90/config-manager` and `@tkottke90/logger` come from the
private npm registry (see the root `.npmrc`) — `npm install` needs network
access to `npm.artifacts.tdkottke.com` and a valid `NPM_TOKEN`.

## Commands (run from `api/`, or with `--workspace api` from the repo root)

```sh
npm run dev      # tsx watch src/index.ts
npm run build    # tsc -p tsconfig.json -> dist/
npm start        # node dist/index.js (run build first)
npm test         # mocha (test/**/*.test.ts)
```

Linting and formatting are configured at the repo root — run `npm run lint`
/ `npx prettier --check .` from the repo root, not from `api/`.

## Before committing

Tests, linting, and style checks must all pass — see the root `AGENT.md`
checklist. For changes scoped to `api/`, at minimum run `npm test` here and
`npm run lint` from the repo root before committing.
