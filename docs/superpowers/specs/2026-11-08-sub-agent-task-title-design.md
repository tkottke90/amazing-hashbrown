# Sub-Agent Task Title Decoupling — Design

**Date:** 2026-11-08
**Status:** Draft
**Related:** `GLOSSARY.md` → "Sub-Agent Dispatch" (**Sub-Agent Goal**, **Generated Title**, **Sub-Agent Task**, **Dispatch**), "Task Runs" (**Scope Snapshot**), "Task Files" (**Task Goal**, **Task File**) — [ADR-0059](../adr/0059-sub-agent-task-titles-generate-async-fall-back-to-truncation.md), [ADR-0057](../adr/0057-hand-off-resolution-gets-one-guidance-to-rewrite-flow.md) (the error-surfacing precedent this design deliberately departs from), [ADR-0055](../adr/0055-sub-agent-tasks-never-surface-on-the-task-board-or-hand-off-to-a-user.md) (why a Sub-Agent Task has no Task Drawer/Task File to redirect to), [Sub-Agent Delegation design](./2026-11-01-sub-agent-delegation-design.md)

---

## Goal

Stop task/thread titles from rendering as multi-paragraph text blocks in the chat window and as an oversized page header in the thread view — reported as a UI bug, traced to Sub-Agent Task titles holding the full `spawn_sub_agent` instruction verbatim.

---

## Problem

`Task.title` currently does triple duty: it is the literal first line of a Run's agent kickoff instruction (`Begin work on this task now: ${task.title}`), the chat-bubble text (`TaskRunMarkerMessage`), and the thread/page header text plus browser-tab title (`TaskRunView`). For an ordinary, user- or `create_tasks`-created Task this is tolerable, because its `title` is already meant to be short ("Short task title.") with a separate `description` for detail. For a Sub-Agent Task, it is not: `createSubAgentTask` sets `title: input.goal` and leaves `description` unset, so the entire Sub-Agent Goal — a full, self-contained instruction, since a sub-agent "starts with no context beyond this goal" — ends up as the title, verbatim, with nothing to shorten it. That is exactly what the reported screenshots show.

Three of the four places that mint a thread title already truncate to `content.slice(0, 50)` (plain chat, wiki, workspace chat); only the task-run thread title and the two screenshot surfaces skip that convention. `Task.description`, meanwhile, already flows correctly to the agent — both `buildTaskContextBlock` (the run-time system prompt, for ordinary and Sub-Agent runs alike) and the plan-generation/Task-File prompts already render a `Description:` line when it is non-null — it is simply never populated for Sub-Agent Tasks today.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                 | Rationale                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No new schema field. `createSubAgentTask` splits the Dispatch's `goal` into a short `title` and a verbatim Sub-Agent Goal stored in `description`, reusing the `title`/`description` split every other Task type already has.                           | `description` already reaches the agent (via `buildTaskContextBlock`) and already backs Scope Snapshot comparison — no migration, no new field, no new surface to keep in sync.                                                         |
| D2  | The short `title` is a Generated Title: produced by a dedicated one-shot LLM call, not supplied by the spawning agent and not a primary mechanical truncation.                                                                                          | Asking the spawning agent for a title too would put summarization burden back on the parent agent; mechanical truncation alone produces mid-sentence cutoffs. See ADR-0059 for the full trade-off.                                       |
| D3  | Generation is asynchronous: `createSubAgentTask` returns immediately with a mechanical-truncation placeholder as `title`, and the Generated Title overwrites it once ready.                                                                             | Preserves Dispatch's existing "returns immediately" contract and adds zero latency to the parent agent's tool call. See ADR-0059.                                                                                                        |
| D4  | Generation uses `env.defaultProvider`, never the Sub-Agent Task's own Role.                                                                                                                                                                              | The Role isn't resolved until the Run starts; reusing it would construct a model twice and risks spending an expensive model's budget on a title. See ADR-0059.                                                                          |
| D5  | On any generation failure or timeout, fall back silently to the truncation placeholder; never block or error the Dispatch call.                                                                                                                         | A cosmetic feature must not be able to break task creation. Deliberately departs from Hand-Off Guidance's error-surfacing precedent (ADR-0057) — see ADR-0059 for why that precedent doesn't apply here.                                 |
| D6  | `create_tasks`' `title` schema gets an actual max-length validation. It was previously guidance-only (`.describe('Short task title.')`, no `.max()`).                                                                                                   | Guidance-only is exactly the kind of soft constraint that let Sub-Agent Goal collapse into `title` in the first place; a real constraint closes the same gap for the one remaining caller-supplied title path.                           |
| D7  | One shared length constant (60 characters) governs the `create_tasks` validation (D6), the truncation placeholder/fallback (D3/D5), and the Generated Title prompt's target length.                                                                     | A single constant can't drift across the three call sites the way three independently-chosen numbers could.                                                                                                                              |
| D8  | Every surface that reads `task.title` for display converges on the same field going forward: `TaskRunMarkerMessage`'s chat bubble, `TaskRunView`'s header and browser-tab title, the persisted `Thread.title` for a Run's own thread, the sidebar, and the Kanban board card.                                     | Patching only the two surfaces from the screenshots while others kept reading the same overloaded field would just move the inconsistency one layer down.                                                                               |
| D9  | Single-line CSS `truncate` (matching the sidebar's existing convention, not the Kanban board's multi-line `line-clamp`) is added to the two originally-broken surfaces as a backstop, not as the primary fix.                                           | Defends historical rows (D11 — no backfill) and the rare async-generation race (D3) without pretending CSS alone solves the underlying overload.                                                                                         |
| D10 | A click-to-expand disclosure is added to the same two surfaces, revealing `task.description` (the full Sub-Agent Goal) in place.                                                                                                                        | A Sub-Agent Task never gets a Task Drawer or Task File (ADR-0055) — unlike an ordinary Task, there is no existing surface to redirect a "view full instruction" affordance to.                                                            |
| D11 | No backfill of already-created Sub-Agent Task rows whose `title` already holds the full Sub-Agent Goal text.                                                                                                                                             | One-time cosmetic gain for real migration risk; D9's display-layer truncation already covers these rows going forward.                                                                                                                    |

---

## Non-goals

- **Backfilling or regenerating titles for already-created Sub-Agent Tasks** (D11).
- **Any change to ordinary (non-sub-agent) Task title/description handling** beyond the new max-length validation (D6) — these already use `title`/`description` correctly and already surface the full `description` via the existing Task Drawer.
- **Any change to ordinary chat/wiki/workspace-chat thread titling** (`content.slice(0, 50)`) — not reported broken, out of scope.
- **Live-updating an already-rendered title** if the rare async-generation race (D3) occurs while a user happens to be viewing the thread at that exact moment — the next page load shows the correct title; not worth the added complexity for a rare, low-stakes case.
- **A dedicated "cheap model" configuration concept** for one-shot utility calls — D4 reuses the existing `env.defaultProvider` fallback instead of introducing new configuration surface.

---

## Open implementation notes (not design decisions — flagged for the implementer)

- The shared 60-character constant (D7) should live somewhere both `create-tasks.tool.ts`'s Zod schema and the new Generated Title code can import, rather than being duplicated as a literal in each.
- `spawn-sub-agent.tool.ts`'s handler and `createSubAgentTask` (`workspace-store.ts:2562-2582`) currently have no LLM client in scope at all — wiring one in for the generation call (D2–D4) is new plumbing, not reuse of something already constructed there.
- The Generated Title overwrite (D3) needs a path that updates `Task.title` after `createSubAgentTask` has already returned and the row already exists — confirm whether this reuses the existing `patchTask` path or needs its own.
- Confirm whether `TaskRunView`'s `run.taskTitle` and the `task_run_marker` message's `taskTitle` payload are live-joined from `Task.title` or snapshotted at creation/kickoff time — this determines whether an in-flight Generated Title update (D3) is visible to a surface that already rendered before it completed, or only to surfaces rendered afterward.
