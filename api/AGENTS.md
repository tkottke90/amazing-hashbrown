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
                     agents/**/*.test.ts — unit tests live adjacent to their subject
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
  app.test.ts       — test files sit next to the file they test throughout src/
  index.ts          Server entrypoint — reads env.port, calls app.listen
tests/
  fixtures/         Shared mock-data factories (e.g. makeMcpTool)
  utilities/        Shared test helpers (supertest wrappers, logger suppressors, etc.)
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
disk. `loadConfig` returns the `ConfigManager` instance itself, exported as
`configManager`; `env` is a plain object of resolved values (`env.port`,
`env.logLevel`, etc.) derived from it for convenient reads outside a
request — for a new field, add it to `AppConfigSchema` (with a
`.default(...)`) and to `env`, rather than reading ad hoc env vars.

`app.ts` assigns `app.config = configManager` (typed via `ConfigManager`
from `@tkottke90/config-manager` in the same `express.d.ts` augmentation as
`app.logger`), so route handlers can reach the full manager — `get()`,
`getNumber()`, `getSection()`, `reload()`, etc. — as `req.app.config`,
instead of just the flattened `env` snapshot.

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

## Testing

See the root `AGENTS.md` for the full testing philosophy, test types, anti-patterns, and tagging conventions.

**api-specific conventions:**

- Test files (`*.test.ts`) live **adjacent to the source file they test** — `src/agents/chat-agent.ts` → `src/agents/chat-agent.test.ts`
- Shared mock-data factories belong in `tests/fixtures/`; shared helpers (supertest wrappers, stub factories, etc.) in `tests/utilities/`
- Import shared fixtures and utilities via the `@/tests/*` path alias (e.g. `@/tests/fixtures/registered-tool.fixture.js`)
- Framework: **Mocha + Chai**

---

## Before committing

Tests, linting, and style checks must all pass — see the root `AGENT.md`
checklist. For changes scoped to `api/`, at minimum run `npm test` here and
`npm run lint` from the repo root before committing.
