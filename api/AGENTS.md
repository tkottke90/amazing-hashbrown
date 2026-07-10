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

**Non-negotiable: all application code must have unit tests.** Routes, agents, tools, services, and middleware ship with tests. Untested code is not considered complete and will not be merged.

### Testing Blacklist

Not everything needs a test. Skip tests only for code where the codebase has no control over the outcome and no processing logic is present:

- Third-party library wiring (`loadConfig`, `configureFromSchema`, `createReactAgent` call sites)
- Pure type/interface files and Zod schema definitions with no runtime behaviour
- Barrel/re-export files (`index.ts` files that only collect and re-export)

Everything else — route handlers, agent logic, tool implementations, service modules, middleware — must be tested.

### Test Types

Test files (`*.test.ts`) live **adjacent to the source file they test** — `src/agents/chat-agent.ts` is tested by `src/agents/chat-agent.test.ts`. This keeps the test and its subject co-located so they can be navigated and reviewed together. Shared mock data factories belong in `tests/fixtures/`; shared test helpers (supertest wrappers, stub factories, etc.) belong in `tests/utilities/`. Import them via the `@/tests/*` path alias (e.g. `@/tests/fixtures/registered-tool.fixture.js`).

All tests use **Mocha + Chai**. Choose the type that matches the scope of what you are verifying. Prefer many small, focused tests over one large cumulative test. Tests should assert on _behaviour_ (what the code does) rather than _implementation_ (how it does it internally).

#### Unit Tests

Scope: a single function or module in complete isolation. All external dependencies (filesystem, HTTP clients, database, LangChain models) are replaced with stubs or mocks — the test controls every input and asserts every output.

Use for: pure data-transformation logic, input validation, Zod schema parsing, tool `execute()` handlers, utility functions, and any module that does processing. This is the **default test type** — reach for it first.

Example targets in this package: individual route handler logic, `mcpToolToLangChain()`, `wrapBuiltin()`, artifact processing helpers.

#### Orchestration Tests

Scope: multiple internal units wired together, but no real external I/O. Use an in-process test client (e.g. `supertest` against the Express app with the LLM and MCP client swapped for fakes) to exercise the full request → middleware → handler → response pipeline.

Use for: verifying that a route correctly delegates to its service layer, that middleware sets the right headers, or that an agent build composes tools in the expected order — without spinning up a real Ollama instance or MCP server.

#### External Orchestration Tests

Scope: the boundary between this application and an external system — an HTTP API, a database, an MCP server, a message queue. These tests do **not** connect to the real external system; they mock its responses so that every scenario the application might encounter can be exercised in a controlled, repeatable way.

Two things to verify for every external boundary:

1. **Outbound contract** — the application sends the right thing (correct HTTP method, path, query parameters, request body shape, headers). Assert on what the application _emits_, not just on what it returns.
2. **Inbound handling** — the application correctly handles the full range of responses the external system might send back: success, expected error conditions (e.g. a database unique-constraint violation, a 404 from a downstream API, a timeout), and unexpected failures.

Use for: a service that calls an external API (stub the HTTP client and assert the outbound request shape, then replay each error response to confirm the service handles it gracefully); a repository layer that talks to SQLite (stub the driver and inject a constraint-failure error to confirm the caller surfaces it correctly); an MCP client integration (mock the server response to verify tool-call parsing under malformed payloads).

The goal is full scenario coverage of the contract — not to prove the external system works, but to prove _this application_ behaves correctly at the boundary regardless of what the external system does.

#### Manual Testing

Scope: exploratory, one-off verification by a human — not automated and not repeatable. Reserve for UI smoke-checks, novel agent flows, or anything where scripting the assertion is impractical.

Manual testing does **not** substitute for an automated test. If you find a bug via manual testing, add a regression unit test before fixing it.

---

## Before committing

Tests, linting, and style checks must all pass — see the root `AGENT.md`
checklist. For changes scoped to `api/`, at minimum run `npm test` here and
`npm run lint` from the repo root before committing.
