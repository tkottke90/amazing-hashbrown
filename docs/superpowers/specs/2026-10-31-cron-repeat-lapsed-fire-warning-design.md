# Cron Repeat Lapsed Fire Warning — Design

**Date:** 2026-10-31
**Status:** Draft
**Related:** [Issue #366](https://github.com/tkottke90/amazing-hashbrown/issues/366), [Cron Task Triggers design](./2026-09-26-cron-task-triggers-design.md) (D6, D9; the `cron_once` "fireAt must be in the future" guard this extends to `cron_repeat`), `GLOSSARY.md` → "Cron Task Recurrence" (**Lapsed Fire**, **Recurrence**)

---

## Goal

When a `cron_repeat` schedule is created or re-enabled, tell whoever (or whatever) created it if one or more of today's own fire times have already passed and will never run — without blocking the save, since the schedule itself stays valid for every day after today.

---

## Problem

- `cron_once` already rejects a `fireAt` in the past (`api/src/services/cron-config.ts:110-116`) — a new or moved one-off that could never fire is refused outright.
- `cron_repeat` has no equivalent. `resolveCronConfig`'s `cron_repeat` branch (`cron-config.ts:129-152`) stamps `enabledAt = now` on create or `enabled: false → true` (`cron-config.ts:146`), and `latestMissedFireAt()` (`cron-schedule.ts:92-127`) only looks for matches in `(max(enabledAt, lastFiredAt), now]`. Any of today's matches that land before that `enabledAt` fall outside the window entirely — never fired, never caught up on a later boot, and nothing tells the caller they were skipped.
- Both callers that create/enable a `cron_repeat` schedule — the REST route (`tasks.handlers.ts`'s `createTaskHandler`/`patchTaskHandler`) and the agent-facing `create_tasks` tool (`create-tasks.tool.ts:188`) — share `resolveCronConfig`, so both are affected. This gap is exactly what produced #366: an agent created its own recurring schedule after some of that day's fire times had already passed, and neither it nor the human it was working for found out.
- The issue's own proposed fix ("require the first scheduled slot be in the future") doesn't actually catch this: a `cron_repeat` expression's *next* match is always in the future by construction (`cron-parser`'s `.next()` can't return a past time). The real gap is about *past* matches silently vanishing, not the next one being invalid.
- Rejecting the schedule outright, the way `cron_once` does, doesn't fit `cron_repeat`: the same expression is perfectly valid starting tomorrow. The only actual problem is the silence.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Warn, never reject**, when a `cron_repeat` schedule's own Lapsed Fires are detected.                                                                                                                             | The schedule stays valid for every future day; rejecting would force a pointless retry loop over something that isn't actually wrong with the schedule.                                                                       |
| D2  | **No grace-period catch-up.** Lapsed Fires are reported, never fired — informational only.                                                                                                                         | A grace period only rescues a near-miss fire time (minutes late); it can't help one that's hours gone (06:00/11:00 in #366's example), and would add a new "how late still counts as on time" threshold nothing else needs. |
| D3  | **Detection window: local midnight through `now`, in the schedule's own IANA timezone** — the same per-task timezone already carried per D9 of the governing design.                                              | Matches "today's fire times" the way a person reading the schedule would, and produces no warning for low-frequency (weekly/monthly) schedules, where a fixed lookback would misfire.                                        |
| D4  | **Scoped to the moment `enabledAt` is (re)stamped** — initial create, or `enabled: false → true` — not every edit to an already-enabled schedule.                                                                 | An edit to an enabled schedule's expression doesn't reset `enabledAt`; it already gets partial catch-up via the existing `latestMissedFireAt` (collapsed to one run, per the existing "one catch-up run" rule) — a different, lesser case than the total miss this issue describes. |
| D5  | **Surfaced in three places from one computation**: the REST create/patch response (additive field), the `create_tasks` tool's returned message text, and `POST /api/v1/triggers/cron/preview`.                    | REST + tool coverage reaches both callers that actually hit the bug; the preview endpoint lets the UI drawer warn while someone is still drafting the schedule, before they've committed to saving it.                        |
| D6  | **Warning text enumerates the specific Lapsed Fire times**, capped (first 5, "+N more" beyond that).                                                                                                               | A generic "something was skipped" message is exactly as useless as today's silence for the scenario in #366 — the point is that the agent (or UI) can tell a human precisely what didn't run.                                 |
| D7  | **No new eval suite.** Standard unit/orchestration coverage only.                                                                                                                                                  | The structurally identical existing precedent — `wiki-update-page.tool.ts` / `wiki-add-cross-link.tool.ts` appending warning text to an otherwise-successful tool result — has no eval coverage either; nothing here raises the stakes enough to depart from that precedent. |

---

## Non-goals

- Changing `cron_once`'s existing past-`fireAt` rejection — it already handles its (simpler, single-fire-time) case correctly.
- Any catch-up of Lapsed Fires, immediate or delayed (D2) — once a fire time is a Lapsed Fire, it is gone for good.
- Warning on edits to an already-enabled `cron_repeat` schedule that don't reset `enabledAt` (D4) — existing, different behavior (partial catch-up), out of scope here.
- A per-task toggle to suppress the warning. If it turns out to be noisy in practice, that's a follow-up.

---

## Design

### Computing Lapsed Fires

New function in `cron-schedule.ts`, alongside `nextFireAt`/`latestMissedFireAt`, using the same `cron-parser` `.prev()` primitive `latestMissedFireAt` already uses:

```ts
// Matches of a cron_repeat expression between local midnight (in its own
// timezone) and `now` — fire times that will never run because they precede
// the `enabledAt` about to be stamped. See GLOSSARY.md "Lapsed Fire".
export function lapsedFiresToday(timing: CronRepeatTiming, now: Date): Date[]
```

Walks backward from `now`, collecting matches until one falls at or before local midnight in `timing.timezone`. Only meaningful for `cron_repeat` — `cron_once` has no "today's matches, plural" concept. Called once, at the point `resolveCronConfig`'s `cron_repeat` branch (re)stamps `enabledAt` (`cron-config.ts:146`, the `turnedOn || !prev` condition) — using the timezone from the incoming config and the new `enabledAt` (`now`) as the right edge.

### Result shape

`CronConfigResult`'s `{ ok: true; config }` branch gains an optional sibling field, `warning?: string` — not a new variant, so every existing `if (!resolved.ok)` caller is unaffected.

### Formatting the message

A small co-located helper turns the `Date[]` into the capped, enumerated text (D6), e.g.:

> "Heads up: today's 06:00, 11:00 and 14:00 runs already passed and won't fire. The schedule will run normally starting with its next fire time."

(Walking the algorithm against this doc's own earlier example — created at 14:10 against `0 6,11,14 * * *` — 14:00 is itself 10 minutes in the past by then, exactly as lapsed as the other two; the warning names all three, not just the first two.)

Reused verbatim by all three surfaces below — nobody re-derives the wording.

### REST surface

`createTaskHandler` / `patchTaskHandler` (`tasks.handlers.ts`): when `resolveCronConfig` returns a `warning`, include it in the handler's success payload (e.g. `{ ok: true, data: { ...task, warning } }`) — additive, consistent with the existing `HandlerResult<T>` contract (`{ ok, data }` / `{ ok, status, error }`) documented in `api/AGENTS.md`.

### Agent tool surface

`create-tasks.tool.ts`: when a task's `resolveCronConfig` call returns a `warning`, append it to that task's line in the tool's returned summary — the same "success text, warning appended" shape already used by `wiki-update-page.tool.ts` / `wiki-add-cross-link.tool.ts`.

### Preview endpoint

`previewCronHandler` (`triggers.handlers.ts`) gains the same Lapsed Fire computation for `cron_repeat` previews — treating "now" as the hypothetical creation/enable moment — added to its existing response alongside `description` / `nextFireTimes`.

---

## Error handling

| Situation                                                                      | Behaviour                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cron_repeat` created/enabled with no Lapsed Fires                              | `warning` absent everywhere — unchanged from today.                                                                       |
| `cron_repeat` created/enabled with Lapsed Fires                                 | Saved as `scheduled` as normal; `warning` present on the REST response, the tool's text, and (pre-save) the preview response. |
| `cron_repeat` edited while already enabled, without an enable transition        | No Lapsed Fire check runs (D4) — existing partial-catch-up behavior unchanged.                                             |
| High-frequency expression (e.g. every minute) with many Lapsed Fires since midnight | Enumeration caps at 5 named times + "N more" (D6); the full count is still computed accurately, only the listed text is capped. |
| `cron_once`                                                                      | Unaffected — its existing past-`fireAt` rejection (`cron-config.ts:114-116`) is unchanged.                                 |

---

## Testing

Per the root `AGENTS.md` and `api/AGENTS.md` conventions — unit + orchestration only (D7).

### Unit (Mocha + Chai, co-located)

- `cron-schedule.test.ts` — new `lapsedFiresToday` cases: none before local midnight; several spanning the midnight boundary; timezone correctness (a time that's "today" in the schedule's zone but "yesterday" in UTC, and vice versa); DST day (spring-forward / fall-back local midnight).
- `cron-config.test.ts` — `resolveCronConfig()` `cron_repeat` branch: `warning` present on create/re-enable with Lapsed Fires; absent with none; absent on an in-place edit that doesn't retrigger `enabledAt`. `cron_once` branch unchanged (still rejects, still no `warning` field).
- Message-formatting helper: cap + "+N more" text at the boundary count and one above it.

### Orchestration

- `tasks.handlers.test.ts` — `createTaskHandler` / `patchTaskHandler` include `warning` in response data when `resolveCronConfig` returns one; omit it otherwise; existing create/patch assertions unaffected.
- `create-tasks.tool.test.ts` — tool's returned text includes the warning appended to the relevant task's line, mirroring the existing wiki-warning tests' shape.
- `triggers.handlers.test.ts` — `previewCronHandler` includes the same warning for a `cron_repeat` preview with Lapsed Fires.

### UI (Jest) / E2E

Not required for this change. The preview endpoint's existing pass-through already reaches the UI; rendering a warning string is cosmetic text display with no new control flow, per the Testing Blacklist in the root `AGENTS.md`. If the drawer is later changed to visually style the warning (banner, icon), that change gets its own Jest test, authored alongside that UI work.

---

## Housekeeping

- `GLOSSARY.md`'s "Cron Task Recurrence" section already has **Lapsed Fire** recorded (committed ahead of this spec).
- `api/AGENTS.md`'s "Scheduled (cron) tasks" section should get a one-line pointer to this spec once implemented, the same way it points at the 2026-09-26 design doc today.
