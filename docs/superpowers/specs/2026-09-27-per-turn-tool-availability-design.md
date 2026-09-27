# Per-Turn Tool Availability in Thread Reports — Design

**Date:** 2026-09-27
**Status:** Approved
**Issue:** [#207](https://github.com/tkottke90/amazing-hashbrown/issues/207)
**Depends on:** None

---

## 1. Problem & Goal

The model sometimes claims it "does not have access" to a tool that the tool drawer shows as
enabled and that the `#<tool-name>` shortcut invokes successfully in the same conversation. Nothing
today records which tools were actually bound to the model on a given turn, so there is no way to
tell whether the tool was genuinely missing or the model is wrong.

The tool list is not static. Two middlewares in the chat agent chain
(`api/src/agents/chat-agent.ts`) filter `request.tools` on every model call:

1. `skillGatedToolsMiddleware` — hides skill-gated tools unless their skill is active this turn.
2. `toolAccessMiddleware` — drops anything outside the thread's effective tool set, and **fails
   closed to the always-on set** if resolving that set throws.

`toolAccessMiddleware` also rewrites the system message per call (drops tool-scoped harness
sections for unbound tools, appends `<tool_guidance>` and `#tool-name` required-tool blocks). The
`system_prompt` stored on the trace today is the pre-filter prompt from agent-build time, so the
report's System Prompt span shows text the model never received.

**Goal:** snapshot, per turn, the exact tool names and system prompt the model received, persist them
on the trace, and render the tool list as chips under the thread report's System Prompt span. This
is an observability surface only — it must not change which tools are bound or add any prompt
content.

---

## 2. Scope

**In scope:**

- A capture middleware on every agent built in `chat-agent.ts`.
- One snapshot per turn (per trace), taken from the turn's first model call.
- Persisting the effective (post-filter) system prompt in place of the build-time prompt.
- Rendering tool chips and a tool count in the thread report
  (`lib/thread-reports/templates/report.njk`).

**Out of scope:**

- The chat message view (`ui/`). The thread report is the investigation surface.
- Per-LLM-call-span snapshots. The gated set is fixed per turn (`activeGatedSkill` is set in
  `beforeAgent`) and drawer settings changing mid-stream is an accepted edge case.
- Agents that do not use the `chat-agent.ts` middleware chain (e.g. wiki ingestion, plan
  generation). Their traces render "tools not captured".
- Any change to which tools are bound or to the system prompt content.

---

## 3. Capture — `model-input-snapshot.middleware.ts`

New file `api/src/agents/model-input-snapshot.middleware.ts`:

```ts
export function createModelInputSnapshotMiddleware(
  getStore: () => Pick<ObservabilityStore, 'recordModelInput'> = getObservabilityStore,
) {
  return createMiddleware({
    name: 'ModelInputSnapshotMiddleware',
    wrapModelCall: async (request, handler) => {
      const traceId = request.runtime.configurable?.trace_id;
      if (traceId) {
        try {
          getStore().recordModelInput(traceId, {
            tools: request.tools.map((t) => t.name as string),
            systemPrompt: /* request.systemMessage.content when a string, else undefined */,
          });
        } catch (err) {
          logger.warn('model-input-snapshot: failed to record', { traceId, err: serializeError(err as Error) });
        }
      }
      return handler(request);
    },
  });
}
```

Rules:

- **Placement:** last in the `middleware` array of every `createAgent` call in `chat-agent.ts`, so
  its `wrapModelCall` is innermost and sees the request exactly as it goes to the model.
- **Tool names:** the bound LangChain names as sent to the model (e.g.
  `playwright__browser_click`), not display ids. This is what the model sees and is what matters
  when it reports a missing tool.
- **System prompt:** `request.systemMessage.content` when it is a string. When it is not a string
  (not produced by this app today), the prompt is omitted and the trace keeps its build-time
  value; tools are still recorded.
- **Pass-through:** always calls `handler(request)` with the unmodified request.
- **No `trace_id`:** no-op (startup warm-up build, evals, uninstrumented callers).
- **Failure:** a store error is logged at `warn` and swallowed. Snapshotting must never block or
  alter the model call.
- **Factory, not singleton:** the store getter is injectable for tests, matching
  `createToolAccessMiddleware`.

### Plumbing `trace_id`

Built agents are cached per `provider:model` (or `workspaceId:provider:model`), so the trace id
cannot be closed over at build time. It travels in `configurable`, alongside `thread_id`, the same
channel `toolAccessMiddleware` already reads.

Every call site that starts a trace and invokes a `chat-agent.ts` agent adds `trace_id: traceId`
to its `configurable`:

- `api/src/agents/stream-handler.ts` — the three `startTrace` sites (currently ~943, ~1144, ~1347).
- `api/src/agents/workspace-chat-stream-handler.ts` — the three `startTrace` sites (~210, ~443, ~674).

`task-execution.ts` and `headless-turn.ts` start no trace, so task runs get no snapshot (the
middleware is still on the task agent and no-ops). `wiki-stream-handler.ts` uses the wiki ingestion
agent, which is out of scope.

In all six sites `config` is currently built before `startTrace`; move it after so it can include
`trace_id: traceId`. The typed `configurable` shape at `stream-handler.ts:488` gains an optional
`trace_id?: string`.

---

## 4. Storage — `lib/observability/src/store.ts`

**Migration** version 33 (1–32 are taken across the single database every store shares, opened
in `api/src/index.ts`):

```sql
ALTER TABLE observability_traces ADD COLUMN tools TEXT;
```

A JSON array of tool names. `NULL` means "not captured" (pre-existing rows, uninstrumented
sources). Not backfilled.

**New write method:**

```ts
recordModelInput(traceId: string, input: { tools: string[]; systemPrompt?: string }): void
```

```sql
UPDATE observability_traces
SET tools = ?, system_prompt = COALESCE(?, system_prompt)
WHERE trace_id = ? AND tools IS NULL
```

- The `tools IS NULL` guard makes the first model call of a turn win; later calls in the same
  turn no-op at the database. No in-memory bookkeeping in the middleware.
- `COALESCE` keeps the build-time prompt when no effective prompt was captured.

**Read side:** `RawTraceSummarySchema` and `RawTraceRecordSchema` add `tools: z.string().nullable()`,
transformed to `tools: string[] | null` via `JSON.parse`. A value that fails to parse as a string
array reads as `null`. The public type lives in `lib/llm-common-types/src/traces/types.ts`:
`TraceRecordSchema` gains `tools: z.array(z.string()).nullable()`, which flows into
`TraceSummarySchema` and `TraceWithSpansSchema` via `.extend`.

**Column semantics change:** `system_prompt` now means "the effective system prompt as sent to the
model, when captured; otherwise the prompt known at `startTrace`". Update the schema comment
(`TraceRecordSchema` in `llm-common-types`) and the version-7 migration's cross-reference to say so. The pre-filter
prompt is not stored separately — it is reproducible from code and config.

---

## 5. Report Rendering — `lib/thread-reports`

The System Prompt `<details>` block in `templates/report.njk` (currently lines 72–80):

- **Render condition** changes from `{% if event.trace.systemPrompt %}` to
  `{% if event.trace.systemPrompt or event.trace.tools != None %}`.
- **Summary line** appends the tool state, visible without expanding:
  - `tools` is a non-empty list → `· N tools`
  - `tools` is `[]` → `· 0 tools`, styled with the existing `.step-badge-warn`
  - `tools` is `null` → `· tools not captured`, muted text
- **Body** renders, above the existing prompt preview, a wrapped row of chips — one
  `<span class="tool-chip">` per tool name, **all tools shown, sorted alphabetically**. No "+N more"
  truncation: the question being answered is "was X bound?", and hiding entries defeats it.
  The prompt preview renders only when `systemPrompt` is present.

`null` and `[]` render differently on purpose: an old, uncaptured trace must never look like a turn
where the model had no tools.

Sorting uses Nunjucks' built-in `sort` filter in the template; `build.ts` is unchanged and the
stored order is left as-is.

**Styling** — new `.tool-chip` and `.tool-chip-row` rules in `templates/base.css`: small monospace
pill modeled on `.span-type`, using the existing color tokens so dark mode is inherited; the row is
`display: flex; flex-wrap: wrap; gap`.

---

## 6. Testing

All developer tests use Mocha with each package's existing assertion style (Chai in `api/`, node
`assert` in `lib/observability`), follow each package's existing test layout, and carry the
AGENTS.md type tag.

**`api/src/agents/model-input-snapshot.middleware.test.ts`**

- records tool names and the string system prompt as they reach the handler `[unit]`
- passes the request to the handler unchanged and returns the handler's result `[unit]`
- does nothing when `configurable.trace_id` is absent `[unit]`
- still completes the model call when the store throws `[unit]`
- records tools but no prompt when `systemMessage.content` is not a string `[unit]`
- with the real `skillGatedToolsMiddleware` → `toolAccessMiddleware` → snapshot chain, a turn with
  the gating skill active records the gated tool and a baseline turn does not `[orchestration]`
- records only the tools that survive `toolAccessMiddleware`'s thread filter `[orchestration]`

**`lib/observability` store tests**

- `recordModelInput` stores tools and the effective prompt on a fresh trace `[unit]`
- a second `recordModelInput` for the same trace is a no-op (first call wins) `[unit]`
- omitting `systemPrompt` preserves the `startTrace` prompt `[unit]`
- `tools` round-trips as `string[]`; `NULL` reads back as `null` `[unit]`

**`lib/thread-reports/test/unit/render.test.ts`**

- renders one chip per tool, sorted, plus the `N tools` count `[unit]`
- renders the `0 tools` warning for an empty list `[unit]`
- renders `tools not captured` for `null` `[unit]`
- renders the System Prompt section when tools are present but the prompt is null `[unit]`

**Stream handler tests** (`stream-handler.test.ts`, `workspace-chat-stream-handler.test.ts`)

- the agent is invoked with `configurable.trace_id` equal to the trace that was started
  `[orchestration]`

**E2E:** none. `e2e/tests/thread-report.spec.ts` mocks the `/report` response wholesale, so a chip
assertion there would only test the mock. No `ui/` behaviour changes; report HTML is covered by
`render.test.ts`.

**Evals:** none. This does not change LLM-facing behaviour.

---

## 7. Acceptance Criteria Mapping

| Issue criterion                                     | Covered by                                              |
| --------------------------------------------------- | ------------------------------------------------------- |
| Each turn's System Prompt span shows tools as chips | §5 rendering                                            |
| Tools labeled by name                               | §3 bound tool names                                     |
| Reflects per-turn availability incl. skill gating   | §3 innermost capture; §6 skill-gated orchestration test |
| Compact pill chips that don't disrupt layout        | §5 styling; chips inside the collapsed `<details>`      |
| Turns with no tools render cleanly                  | §5 `0 tools` / `not captured` states                    |
| Historical turns show availability as it was        | §4 per-trace column, written once at capture time       |
| No regression in rendering performance or layout    | §5 collapsed by default; no change to the chat UI       |

---

## 8. TODO List

If `TODO_LIST.md` carries an item for this issue, move it to "Completed Items" on the
implementation branch.
