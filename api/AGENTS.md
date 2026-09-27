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

## Automated task runs

A `task_queue` row is one **run** of a task. Each run executes in its own
`'task'`-type thread (`task_queue.thread_id`, minted on the run's first start
by `agents/task-execution.ts` and reused when the run continues after a HITL
answer or Resume) and records a one-line `summary` and its `trigger_source`
when it settles. Things to keep in mind when touching this area:

- Never run a task in a shared thread (the workspace chat, an earlier run's
  thread) — per-run threads are what keep a recurring task's context
  bounded. A workspace task's start/end markers and pending questions are
  _copied_ into the workspace chat instead (`recordTaskRunMarker`,
  `mirrorPendingTaskPrompts`).
- A new run's kickoff (`buildRunKickoff` in `agents/task-context.ts`) carries
  the previous run's summary and the exact `read_task_run` call; that tool is
  bound only when such a run exists, and is never described in the system
  prompt.
- Every `/hitl` route delegates task prompts to `answerTaskPrompt`
  (`routes/v1/tasks.handlers.ts`), which re-queues the task — never resume a
  task's prompt as an interactive chat turn. Run threads reject chat, retry
  and fork (409).

### Scheduled (cron) tasks

`cron_once` / `cron_repeat` tasks wait in the `scheduled` status.
`services/cron-registry.ts` (`CronRegistry`) keeps one in-process timer per
such task; the database is the source of truth and a timer is only a
wake-up call:

- Fire only through `store.fireCronTask()` — its gate (`scheduled` and
  enabled) is what skips a fire while a run is still going. Never enqueue a
  cron run any other way.
- Anything that can change a cron task's trigger, status or existence must
  call `getCronRegistry().sync(taskId)` afterwards (routes do this after
  their handler; the executor is wrapped in `withCronResync`). Handlers
  themselves stay registry-free so they remain unit-testable.
- What a finished run does to the schedule (back to `scheduled`, `done`,
  auto-pause after N scheduled failures — manual runs never count) is
  `settleCronRun()` in `services/cron-settlement.ts`, applied by
  `completeQueueEntry`. Fire-time arithmetic, catch-up and DST live only in
  `services/cron-schedule.ts`; the UI never parses cron — it calls
  `POST /api/v1/triggers/cron/preview` and reads each task's computed
  `schedule` field.
- Tests inject `now` / `setTimer` / `clearTimer` into `CronRegistry` (see
  `cron-registry.test.ts`) rather than using real timers.

See `docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md`.

## Headless turns and timed wake-ups

A headless turn (`agents/headless-turn.ts`) runs in an existing thread with no
request attached — a timed wake-up firing or a sub-agent completion. It
claims the thread with its own `AbortController` (so the thread's `/stop`
route cancels it), broadcasts `thread_turn_started`, and records failures as
error rows. Every turn runner — interactive, headless, task or wiki — releases
its thread with `endThreadTurn()` (`agents/pending-thread-turns.ts`), which
broadcasts `thread_turn_completed` and starts the next queued turn; never call
`clearActiveSseWriter()` directly.

Timed wake-ups (`schedule_wakeup` / `cancel_wakeup`, chat and workspace chat
only):

- `services/wakeup-store.ts` (`WakeupStore`) is the only writer of the
  `thread_wakeups` table and of each wake-up's `wakeup` transcript card; it
  updates both in one transaction, and its transitions return `null` unless
  the wake-up is still pending — that gate is what resolves cancel/fire races.
- `services/wakeup-registry.ts` (`WakeupRegistry`) holds one timer per pending
  wake-up (same pattern as `CronRegistry`); `agents/wakeup-delivery.ts` turns a
  fire into a queued headless turn. Routes validate with a handler, then call
  the registry (`triggerNow` / `cancel`), never the store directly.
- Tests inject `now` / `setTimer` / `clearTimer` / `deliver` into the registry.

See `docs/superpowers/specs/2026-09-27-agent-wait-design.md`.

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
