# Feature: per-workspace-task continuity files (`.hashbrown/tasks/`)

## Context

Each task run starts a genuinely new agent thread (`task_queue.thread_id`), and today's only built-in continuity is `buildRunKickoff` carrying forward the *same task*'s previous-run summary, plus PR #306's `task_progress_entries` carrying forward *tracker/dependency-linked* siblings' summaries across workspaces. Neither gives a human or an agent a single, readable artifact of "what happened on this task, across all its runs, in this workspace" — a user watching a sequence of workspace tasks has to reconstruct that by hand from separate run transcripts.

This spec adds a Task File per workspace-scoped task: a markdown artifact, written and read entirely by the harness, holding a Task Goal, a Previous Tasks list, an append-only Task Notes log, a Task Outcome, and Handoff Notes. See `GLOSSARY.md` § Task Files for the vocabulary (Task File, Task State, Task Goal, Previous Tasks, Sibling Progress, Task Notes, Task Outcome, Handoff Notes) and ADR-0035 through ADR-0040 for the architectural decisions this design follows — this spec implements them rather than re-arguing them.

This was reached through a full grilling (design-interview) pass with the repo owner; every section below reflects an explicit answer, not an assumption.

## Existing system (facts gathered during research)

- A `Task` row (`workspace-store.ts:124-190`) is nullable-`workspaceId`; a run is a `task_queue` row (`workspace-store.ts:320-346`). `isNewRun = entry.threadId === null` (`task-execution.ts:156`) — a continuing run (HITL resume, crash-recovery retry) reuses its thread; a genuinely new run gets a fresh one.
- `task-execution.ts` is the orchestrator. Relevant existing hook points: `startSha` capture (~line 168), `config.configurable` build (~362-367), `getGroupContext`/kickoff build (~388-408), and five terminal-ish branches: `complete_task` success (~488-496), stopped-without-completing (~519-541, fixed string `'Stopped without completing the task (ran out of steps or produced no final action).'` at ~520), the generic `finishFailedRun(notifyMessage, summary = notifyMessage)` closure (~561-580), cancel (~585-596, fixed string `'Run cancelled by the user.'` at 588, **no** `recordTaskProgress` call), and take-over (~601-605, fixed string `'Run taken over by the user.'` at 604, **no** `recordTaskProgress` call). Pause (~597-600) calls neither `setQueueEntrySummary` nor `recordTaskProgress` — it isn't terminal.
- `update_plan` (`api/src/agents/tools/update-plan.tool.ts:31-71`) is a `makeUpdatePlanTool(taskId, store?)` factory, built per task run, doing its own direct side effects inline (`store.patchTask` + `broadcast()`) — the precedent ADR-0037 follows.
- Tool convention: one `*.tool.ts` file per tool, `make*Tool(taskId, ...)` factories for per-run tools, a `TOOL_CATALOG` entry (`api/src/agents/tool-catalog.ts`) with `alwaysOn: true` for task-run-only tools (today: `complete_task`, `update_plan`, `read_task_run`, plus `wiki_*`), bound only inside `buildTaskAgent()` (`chat-agent.ts:749-829`).
- Custom agent state is declared by a middleware's `stateSchema` (a Zod object), built via `createMiddleware({ name, stateSchema, ... })` from the `langchain` package — e.g. `activeSkillStateSchema` (`skill-gated-tools.middleware.ts:28-30`), read as `request.state.activeSkill` inside `wrapModelCall`/`beforeAgent`, written by returning a plain partial object from a hook (`skill-expansion.middleware.ts:75`, `return { messages, activeSkill }`). A tool call can mutate graph state by returning a `Command` from `@langchain/langgraph` — confirmed in `binary-content-fetch.middleware.ts:77-88`, `new Command({ update: { pendingImageFetch: {...}, messages: [...] } })`, returned from a `wrapToolCall` override. Package versions: `langchain@1.5.16`, `@langchain/langgraph@1.4.21`, `@langchain/core@1.2.17`.
- `.hashbrown/summaries/*.md` (`workspace-summarizer.ts:106-113`) is the one existing on-disk precedent: ISO-timestamp filenames (colons/dots replaced with dashes) under `workspace.location`, written via plain `writeFile` (not atomic), read by `workspace-chat-stream-handler.ts:40-82`, injected into the workspace-chat system prompt by `buildWorkspaceContextBlock` (`chat-agent.ts:562-601`) as full content of the latest + a manifest of older ones, wired in at `chat-agent.ts:613-616`. The workspace-chat agent's own tool list (`chat-agent.ts:617-635`) already includes `makeShellExecTool(workspaceContext.location, ...)`.
- A ready-made, generic frontmatter+body parse/serialize/atomic-write precedent already exists for a different feature (dashboard Widgets): `lib/amazing-hashbrown-widgets/src/internal/frontmatter.ts:13-22` (`parse`/`serialize` via `gray-matter`, operating on plain `Record<string, unknown>` + body string — not Widget-specific) and `lib/amazing-hashbrown-widgets/src/store.ts:186-189` (`writeFileAtomic`: write to `${filePath}.tmp`, then `fs.rename`). `gray-matter` is already an `api/package.json` dependency (`"gray-matter": "4.0.3"`). This feature writes its own equivalent in `api/src/services/task-file.ts` rather than depending on the widgets library (wrong semantic home for task data), but copies the same two small, proven patterns.
- `provisionGitRepository` (`api/src/services/workspace-provision.ts:50-74`) is the one choke point for both the clone and the `git init` branch of workspace provisioning — the natural place to ensure a `.gitignore` entry.
- Migration ledger: PR #306 landed as migration v42 (`workspace-store.ts:891-924`); next free version is **v43** (re-verify before committing, per this repo's existing convention).

## Design

### 1. Schema change

Migration v43, `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN task_file_path TEXT;
```

`Task.taskFilePath: string | null` — the file's path, relative to `workspace.location`, set once on the task's first run and never recomputed (the filename's timestamp prefix is otherwise unrecoverable without it). This is the *only* new persisted field outside the file itself (ADR-0035) — it is a locator, never a content copy.

### 2. `api/src/services/task-file.ts` (new)

The shared module every write/read site calls directly (ADR-0037 — no middleware-based sync layer).

```ts
export interface TaskState {
  goal: string;
  previousTasks: string[];      // one rendered one-liner per sibling, e.g. "<taskId>: <summary>"
  notes: string[][];            // one array per run; notes[notes.length - 1] is the current run
  outcome: string;
  handoff: string;
}

export const EMPTY_TASK_STATE: TaskState = {
  goal: '', previousTasks: [], notes: [], outcome: '', handoff: '',
};

export const TaskStateSchema = z.object({
  goal: z.string(),
  previousTasks: z.array(z.string()),
  notes: z.array(z.array(z.string())),
  outcome: z.string(),
  handoff: z.string(),
});

export function renderTaskStateToMarkdown(
  state: TaskState,
  meta: { taskId: string; title: string },
): string;
// gray-matter `serialize(body, state)` — body is the rendered sections:
// # Task: <title>
// ## Task Goal / ## Previous Tasks / ## Task Notes (### Run 1 / ### Run 2 / ...)
// ## Task Outcome / ## Handoff Notes

export function parseTaskStateFromMarkdown(raw: string): TaskState;
// gray-matter `parse(raw).data`, validated against TaskStateSchema; throws on
// missing/invalid frontmatter — callers decide what "invalid" means (see loadTaskState).

export async function loadTaskState(
  filePath: string,
): Promise<{ state: TaskState; historyGap: boolean }>;
// ENOENT, or parseTaskStateFromMarkdown throwing → { state: EMPTY_TASK_STATE, historyGap: true }.
// Otherwise → { state: parsed, historyGap: false }.

export async function writeTaskFile(
  filePath: string,
  state: TaskState,
  meta: { taskId: string; title: string },
): Promise<void>;
// mkdir(dirname(filePath), { recursive: true }); atomic write via `${filePath}.tmp` + rename
// (same two-line pattern as lib/amazing-hashbrown-widgets/src/store.ts:186-189).

export function formatTaskFileTimestamp(date: Date): string; // "YYYYMMDDHHMMSS"

export async function listWorkspaceTaskFiles(
  workspaceLocation: string,
  excludeTaskId: string,
): Promise<{ taskId: string; goal: string; outcome: string; createdAt: string }[]>;
// readdir .hashbrown/tasks/, parse each *-<taskId>.md's frontmatter (tolerate one bad
// file the same way loadWorkspaceSummaries tolerates ENOENT — skip and log, don't throw),
// sorted chronologically by filename. Used both for a run's own Previous Tasks (§3) and
// for the workspace-chat manifest (§6). Never includes a Sub-Agent Task's file, because
// a Sub-Agent Task never has one (§3).
```

### 3. `task-execution.ts` integration

Guard at the top: **a run only touches Task Files when `task.workspaceId` is set and `task.origin !== 'agent'`** — a workspace-less ("inbox") task has no `workspace.location` to write into, and a Sub-Agent Task is explicitly excluded by this same guard. This single guard is also what keeps Sub-Agent Tasks out of every other task's Previous Tasks list — since `listWorkspaceTaskFiles` (§2) only ever sees files that exist on disk, and a Sub-Agent Task's run never creates one, no separate filter is needed at read time.

**Pre-run** (before the existing kickoff build at ~397-408):

1. If `task.taskFilePath` is `null` (first-ever run), compute it — `path.join('.hashbrown', 'tasks', \`${formatTaskFileTimestamp(new Date())}-${task.id}.md\`)` relative to `workspace.location` — and persist via `store.patchTask(task.id, { taskFilePath })`.
2. `{ state, historyGap } = await loadTaskState(absolutePath)`.
3. `previousTasks = await listWorkspaceTaskFiles(workspace.location, task.id)`, rendered to one-liners of the form `"<taskId>: <entry.outcome>"` — the Previous Tasks list's one-sentence summaries are each sibling's Task Outcome (ADR-0038), not its Goal. (§6's workspace-chat manifest renders the same `listWorkspaceTaskFiles` result differently — by `goal` instead of `outcome` — because there the point is letting the user pick *which* task to ask about, not summarizing what already happened.)
4. `goal = await generateTaskGoal({ task, previousTasks })` — a new, standalone LLM call outside the main agent loop, defined in a new `api/src/agents/task-file-generators.ts` alongside `generateHandoffNotes` (§3 Post-run), following the same "harness makes a one-off model call before/after the real run" shape already used by `POST /api/v1/tasks/generate-plan` (`api/src/agents/plan-generation.ts`). Reads title/description/outcome/plan plus `previousTasks`; returns a short first-person restatement of what the task is trying to do.
5. `state.goal = goal; state.previousTasks = previousTasks;`
6. If `isNewRun`, `state.notes.push([])` (a fresh segment for this run); a continuing run reuses `state.notes[state.notes.length - 1]`.
7. If `historyGap`, push a note into the current run's segment recording that prior history could not be read (file missing or frontmatter unparseable) — visible, not silent (per the earlier grilling round on this exact fallback).
8. `await writeTaskFile(absolutePath, state, { taskId: task.id, title: task.title })`.
9. Pass `state` as the agent invocation's initial `taskState` (see §4 on how this reaches the graph).

**Mid-run**: handled entirely by the `write_task_note`/`update_plan` tools (§4) — `task-execution.ts` does nothing further until the run ends.

**Post-run** — one new helper, `finishTaskFile(task, filePath, state, outcomeSummary)`, called from every terminal branch except pause:

```ts
async function finishTaskFile(task, filePath, state, outcomeSummary) {
  state.outcome = outcomeSummary;
  state.handoff = await generateHandoffNotes({ task, state }); // new standalone LLM call, task-file-generators.ts
  await writeTaskFile(filePath, state, { taskId: task.id, title: task.title });
}
```

Called with whatever summary text that branch already produces: the model's `complete_task` summary (success), the fixed `stoppedSummary` string, `finishFailedRun`'s `summary` parameter, or the fixed cancel/take-over strings — reusing it verbatim (ADR-0036). `state` here is the *final* `taskState` read back from the agent invocation's result (standard `createAgent` behavior: the resolved state includes every custom field a bound middleware's `stateSchema` declared — see §4), not a separately-tracked copy. `recordTaskProgress`/`task_progress_entries` (PR #306, DB-backed) is untouched — cancel and take-over newly get a `finishTaskFile` call that `recordTaskProgress` still skips; that's an intentional divergence, not a bug (Round 3 of grilling, "extend file coverage to cancel/take-over too").

### 4. Graph state and the two new tools

A minimal new middleware, `api/src/agents/task-file-state.middleware.ts`, contributes the schema slice (no hooks of its own — purely declares the field so it's part of the graph's checkpointed state):

```ts
export const taskFileStateSchema = z.object({
  taskState: TaskStateSchema.default(EMPTY_TASK_STATE),
});
export function createTaskFileStateMiddleware() {
  return createMiddleware({ name: 'TaskFileStateMiddleware', stateSchema: taskFileStateSchema });
}
```

Bound only in `buildTaskAgent()`'s `middleware: [...]` array, alongside the existing ones. `task-execution.ts` seeds the initial invocation with `taskState: state` (the value built in §3); after `agent.invoke(...)` resolves, it reads `result.taskState` back out for §3's post-run step.

Two new tools, built exactly like `update_plan` (per-run factory, `alwaysOn: true`, task-run-only):

- **`write_task_note.tool.ts`** — `makeWriteTaskNoteTool(taskId, filePath, store?)`. Input: `{ note: string }`. Implementation: read the current run's notes segment from `runtime.state.taskState` (`notes[notes.length - 1]`), append `args.note`, call `writeTaskFile(filePath, newState, meta)` inline (ADR-0037), and return `new Command({ update: { taskState: newState }, messages: [ToolMessage(...)] } })` from `@langchain/langgraph` so the graph's own checkpointed state reflects the change for the rest of this run (the same `Command`-from-a-tool-call mechanism already used in `binary-content-fetch.middleware.ts:77-88`, applied here from the tool's own return value rather than a `wrapToolCall` override — confirm this exact call shape with a short implementation spike before relying on it, since every existing example in this codebase goes through `wrapToolCall`, not a bare tool's own return).
- **`read_task_notes.tool.ts`** — `makeReadTaskNotesTool(taskId)`. No input. Returns `renderTaskStateToMarkdown(runtime.state.taskState, meta)` — the full current file content, computed from in-memory graph state rather than re-reading the file from disk (they're identical by construction, since every mutation path writes through `writeTaskFile` immediately).
- **`update_plan` (extended, not replaced)** — after its existing `store.patchTask` + `broadcast()` (`update-plan.tool.ts:31-71`), it now also appends one mechanical note per changed step (e.g. `"Step 3 marked done."`) to the current run's notes segment and calls `writeTaskFile` + returns the same kind of `Command` update as `write_task_note`, immediately following Round 1 Q9's answer: plan-step progress belongs in the same Task Notes log as freeform agent notes, interleaved in call order.
- Catalog entries (`tool-catalog.ts`): `write_task_note` and `read_task_notes`, `alwaysOn: true`, bound only inside `buildTaskAgent()` — never in chat, workspace-chat, or sub-agent contexts.

### 5. `.gitignore` for `.hashbrown/`

`provisionGitRepository` (`workspace-provision.ts:50-74`) gets one addition after either branch (clone or `git init`) succeeds: ensure `.gitignore` in `location` contains a `.hashbrown/` line — append it if a `.gitignore` already exists (from a cloned repo) and doesn't already cover it, create a one-line `.gitignore` if none exists. This single fix covers both `.hashbrown/summaries/` (pre-existing gap) and the new `.hashbrown/tasks/` (ADR-0040). A workspace with `opts.git === false` has no repo to guard and is skipped, same as today.

### 6. Workspace-chat manifest (ADR-0039)

`buildWorkspaceContextBlock` (`chat-agent.ts:562-601`) gets a new block, built from the same `listWorkspaceTaskFiles` helper (§2) called with no exclusion (every task file in the workspace):

```
## Task files
- <taskId> — "<goal>" (<createdAt>)
- <taskId> — "<goal>" (<createdAt>)
...

Full detail for any of these lives in its own file — use shell_exec to read
.hashbrown/tasks/<file> only when the user asks about that specific task.
```

Same "list everything, fetch content on demand" register as the existing summaries block's "reach for shell_exec only when asked" instruction (`chat-agent.ts:597`) — not full content, since unlike the single latest summary there's no one obviously-most-relevant task file to always spend context on.

### 7. Error handling

- Missing/corrupt Task File on load → `EMPTY_TASK_STATE` + a visible history-gap note (§3 step 7), never a hard failure of the run.
- Every mechanical write is atomic (temp + rename); a write failure is logged and does not fail the run or the tool call it came from — matches `recordTaskProgress`'s own "never block the task's own completion" posture, applied here to file I/O instead of DB/git calls.
- `generateTaskGoal`/`generateHandoffNotes` failures (model error, timeout) degrade to an empty string for that field rather than failing the run — a missing Task Goal or Handoff Notes is a lesser artifact, not a broken one.

## Testing

**Backend:**

- `task-file.test.ts` (new): `renderTaskStateToMarkdown`/`parseTaskStateFromMarkdown` round-trip; `loadTaskState` on missing file, corrupt frontmatter, and a well-formed file; `writeTaskFile`'s atomic-write behavior (temp file then rename, stubbing `fs`); `listWorkspaceTaskFiles` skipping one malformed file among several good ones, and rendering by `outcome` vs. `goal` for its two call sites.
- `task-file-generators.test.ts` (new): `generateTaskGoal`/`generateHandoffNotes` — stub the model call; assert the right fields are read from `task`/`previousTasks`/`state`, and that a model error degrades to an empty string rather than throwing.
- `update-plan.tool.test.ts` (extended): asserts the new Task Notes entry + `writeTaskFile` call alongside the existing `patchTask`/`broadcast` assertions.
- `write-task-note.tool.test.ts` / `read-task-notes.tool.test.ts` (new): note appended to the correct run segment; `read_task_notes` returns the current rendered state; both scoped to `taskId`.
- `task-execution.test.ts` (extended): Task File steps run for a workspace-scoped, non-Sub-Agent-Task run and are skipped for an inbox task and a Sub-Agent Task; `historyGap` note appears when the file is missing; `finishTaskFile` is called with the right summary text for each of the five non-pause terminal branches (success, stopped-without-completing, generic fail, cancel, take-over) and *not* called for pause.
- `workspace-provision.test.ts` (extended): `.gitignore` is created/appended correctly for both the clone and `git init` branches, and left alone when `git: false`.
- `chat-agent.test.ts` (extended): `buildWorkspaceContextBlock`'s new task-files block renders the manifest and the shell_exec instruction.

**Frontend:** none — no UI surface (Round 1, Q8).

**Out of scope, explicitly not built here:** any UI for viewing a Task File; pruning or capping Task Notes' growth over many runs; reusing this mechanism for Sub-Agent Tasks or inbox tasks; any change to PR #306's `task_progress_entries`/Sibling Progress mechanism.
