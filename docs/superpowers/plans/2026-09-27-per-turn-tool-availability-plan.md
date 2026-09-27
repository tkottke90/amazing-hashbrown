# Plan — Per-Turn Tool Availability in Thread Reports (#207)

## Context

The model sometimes claims it lacks a tool that is enabled in the drawer and works via `#tool-name`.
Nothing records which tools were actually bound per turn, and the trace's stored `system_prompt` is
the pre-filter build-time prompt, not what the model received (`toolAccessMiddleware` rewrites it per
call). Approved spec: `docs/superpowers/specs/2026-09-27-per-turn-tool-availability-design.md`.

Outcome: a capture middleware snapshots the final tool names + effective system prompt on the first
model call of each turn, stores them on the `observability_traces` row, and the thread report renders
a tool count + chips inside the System Prompt span.

## Findings that amended the spec

- `TraceRecordSchema` lives in `lib/llm-common-types/src/traces/types.ts:50-81`, not in
  `lib/observability` — the new field goes there.
- `task-execution.ts` (and `headless-turn.ts`) start **no trace** — nothing to plumb there. Drop it
  from the spec. Plumbing is 6 sites: 3 in `stream-handler.ts`, 3 in `workspace-chat-stream-handler.ts`.
- `wiki-stream-handler.ts` uses `getWikiIngestionAgent` (not chat-agent) — out of scope, as specced.
- Migration **33** confirmed free (1–32 used across the single shared DB opened in `api/src/index.ts:31`).
- Store SELECTs use `t.*` / `SELECT *` — no query column lists to change, only the Raw row schemas.
- Sorting: use Nunjucks' built-in `sort` filter in the template; no `build.ts` change.

## Steps

### 1. Amend the spec

Done alongside this plan — the spec now reflects the findings above.

### 2. Types — `lib/llm-common-types/src/traces/types.ts`

Add `tools: z.array(z.string()).nullable()` to `TraceRecordSchema` (flows into `TraceSummarySchema`
and `TraceWithSpansSchema` via `.extend`). Update the `systemPrompt` field comment to the new
semantics ("effective prompt as sent when captured, else prompt known at startTrace").

### 3. Store — `lib/observability/src/store.ts`

- Migration `{ version: 33, sql: 'ALTER TABLE observability_traces ADD COLUMN tools TEXT;' }` with a
  comment in the style of v7/v9.
- `RawTraceSummarySchema` (:51) and `RawTraceRecordSchema` (:95): add `tools: z.string().nullable()`;
  transform with a small shared `parseTools(raw)` helper → `string[] | null` (JSON.parse in try/catch,
  must be an array of strings, else `null`).
- New `recordModelInput(traceId, { tools, systemPrompt? })`:
  `UPDATE observability_traces SET tools = ?, system_prompt = COALESCE(?, system_prompt) WHERE trace_id = ? AND tools IS NULL`.
- Tests in `lib/observability/test/unit/store.test.ts` using existing `makeStore()` (:10-15), assert style
  of the `error` round-trip test (:100-114):
  - stores tools + effective prompt; readable via `findById` and `getTrace` `[unit]`
  - second call is a no-op (first wins) `[unit]`
  - omitted `systemPrompt` keeps the `startTrace` prompt `[unit]`
  - untouched trace reads `tools === null` `[unit]`

### 4. Middleware — `api/src/agents/model-input-snapshot.middleware.ts` (new)

`createModelInputSnapshotMiddleware(getStore = getObservabilityStore)` via `createMiddleware` from
`langchain`, `wrapModelCall` only:

- `traceId = request.runtime.configurable?.trace_id`; if absent → `return handler(request)`.
- try `getStore().recordModelInput(traceId, { tools: request.tools.map(t => t.name as string), systemPrompt: typeof content === 'string' ? content : undefined })`;
  catch → `logger.warn(..., { traceId, err: serializeError(err as Error) })`
  (`import { logger, serializeError } from '../config/logger.js'`).
- Always `return handler(request)` unmodified. Export a default singleton `modelInputSnapshotMiddleware`.
- Header comment in the style of `tool-access.middleware.ts`: why innermost, why `configurable`
  (agents cached per provider:model), why first-call-wins lives in SQL.

Tests `model-input-snapshot.middleware.test.ts`, modeled on `tool-access.middleware.test.ts:19-57`
(`fakeRequest` with `runtime.configurable`, `SystemMessage`), with a fake store capturing calls:

- records tool names + string prompt `[unit]`; passes request through unchanged and returns handler
  result `[unit]`; no `trace_id` → no store call `[unit]`; throwing store → handler still runs `[unit]`;
  non-string system content → tools recorded, prompt undefined `[unit]`.
- Orchestration: chain the real `createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS)` →
  `createToolAccessMiddleware(cfg)` → snapshot by nesting `wrapModelCall` handlers; assert a gated
  tool is recorded only when `activeGatedSkill` matches, and a thread-disabled tool is absent
  `[orchestration]`. Reuse the temp-DB boot from `tool-access.middleware.test.ts:64-70`; state must
  carry both `activeGatedSkill` and `requestedToolIds`.

### 5. Wire into agents — `api/src/agents/chat-agent.ts`

Append `modelInputSnapshotMiddleware` as the **last** entry of the `middleware` arrays in
`buildChatAgent` (:390), `buildWorkspaceChatAgent` (:488), `buildTaskAgent` (:636) — after
`afterAgentMiddleware` so its `wrapModelCall` is innermost. Skip `buildSubAgentAgent` (no callers).
Task agents get the middleware but no `trace_id` today → no-op, harmless.

### 6. Plumb `trace_id`

In each of the 6 handlers `config` is built before `startTrace`. Move the `const config = {...}`
line to just after `startTrace` and include `trace_id: traceId`.

- `api/src/agents/stream-handler.ts`: `streamChatToSse` (:914/:943), `resumeChatToSse` (:1123/:1144),
  `retryChatToSse` (:1323/:1347). Check nothing between the old and new position reads `config`;
  if something does, keep the build early and spread a second object at the `streamEvents` call
  instead. Widen the typed shape at :488 with `trace_id?: string`.
- `api/src/agents/workspace-chat-stream-handler.ts`: :195/:210, :418/:443, :646/:674, same pattern.
- Tests: in `stream-handler.test.ts` (fake agents ~:1333/1359/1381) and
  `workspace-chat-stream-handler.test.ts` (~:147/170/192), capture the `streamEvents` options
  (pattern: `task-execution.test.ts:147`) and assert `options.configurable.trace_id` equals the id of
  the trace the store opened (read back via the store's `find({ threadId })`) `[orchestration]` —
  one per handler function.

### 7. Report — `lib/thread-reports/templates/report.njk` + `base.css`

- Condition at :72 → `{% if event.trace.systemPrompt or event.trace.tools != None %}`.
- Summary (:76) appends: `· N tools` | `<span class="step-badge step-badge-warn">0 tools</span>` |
  `<span class="tools-not-captured">· tools not captured</span>`.
- Body: `<div class="tool-chip-row">{% for t in event.trace.tools | sort %}<span class="tool-chip">{{ t }}</span>{% endfor %}</div>`
  when non-empty, then the existing preview only if `systemPrompt`.
- CSS: `.tool-chip-row { display:flex; flex-wrap:wrap; gap:0.25rem; margin:0.25rem 0; }`,
  `.tool-chip` (mono, 0.7rem, `var(--bg-hover)` bg, `var(--border)` border, `var(--radius)`/pill,
  `var(--text)`), `.tools-not-captured { color: var(--text-muted); }`. Tokens already switch for dark.
- `systemPromptTokens` (`build.ts:164-173`) now estimates the effective prompt automatically — no change.
- Tests in `lib/thread-reports/test/unit/render.test.ts`: extend `traceFixture` (:81-110) with
  `overrides.tools` (default `null`); add: sorted chips + `3 tools` `[unit]`; `0 tools` warning
  `[unit]`; `tools not captured` for null `[unit]`; section renders with tools but null prompt `[unit]`.
  Keep existing :112-121 tests passing (null prompt + null tools → no section).

### 8. Housekeeping

No `TODO_LIST.md` entry exists for #207 — nothing to move. No E2E or eval changes (per spec).

## Verification

From repo root:

```sh
npm run build:libs          # llm-common-types → observability → thread-reports compile
npm test --workspace lib/observability
npm test --workspace lib/thread-reports
npm test --workspace api
npm run lint && npx prettier --check . && npm test   # required pre-commit gate
```

Manual end-to-end (if an LLM provider is reachable): `npm run dev:api` + `npm run dev:ui`, send a
chat turn, send `/create-workspace …` (a gated skill), generate the thread report, and confirm the
second turn's chip list includes the gated tool while the first doesn't, and the System Prompt
preview shows `<tool_guidance>`/filtered sections. Also open a report for a pre-existing thread and
confirm old turns show "tools not captured".

Commit in logical chunks (lib types+store, middleware+wiring+plumbing, report), push to
`claude/tender-ptolemy-vmvz3m`.
