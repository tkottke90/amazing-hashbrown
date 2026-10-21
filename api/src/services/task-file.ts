import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { logger, serializeError } from '../config/logger.js';

// A Task File's own structured state — the YAML frontmatter of its
// markdown file, and the only durable copy of this data (ADR-0035). The
// markdown body is a pure rendering of this same state, never a second
// copy with its own meaning. See
// docs/superpowers/specs/2026-10-21-workspace-task-files-design.md,
// GLOSSARY.md § Task Files.
export interface TaskState {
  goal: string;
  // One rendered one-liner per sibling task in this workspace, e.g.
  // "<taskId>: <outcome>" — overwritten each run, not accumulated (ADR-0038).
  previousTasks: string[];
  // One array per run; notes[notes.length - 1] is always the current run's
  // segment. The only part of a Task File with per-run history — everything
  // else here holds only the latest snapshot.
  notes: string[][];
  outcome: string;
  handoff: string;
}

export const EMPTY_TASK_STATE: TaskState = {
  goal: '',
  previousTasks: [],
  notes: [],
  outcome: '',
  handoff: '',
};

// EMPTY_TASK_STATE is a module-level singleton for comparison/reference
// purposes only (e.g. `.to.deep.equal(EMPTY_TASK_STATE)` in tests) — it
// must never be handed to a caller that might mutate it (directly, or via
// `.notes.push(...)`), or that mutation leaks into every other caller that
// gets the same "empty" default. Always hand out a fresh copy instead.
// Exported so taskFileStateSchema (task-file-state.middleware.ts) can use
// it as a factory default — Zod's `.default(someObject)` only shallow-
// clones the top level on each parse, leaving nested arrays like `notes`
// shared by reference across every defaulted call; `.default(fn)` calls
// the factory fresh every time instead, which is what actually avoids that.
export function cloneEmptyTaskState(): TaskState {
  return { goal: '', previousTasks: [], notes: [], outcome: '', handoff: '' };
}

export const TaskStateSchema = z.object({
  goal: z.string(),
  previousTasks: z.array(z.string()),
  notes: z.array(z.array(z.string())),
  outcome: z.string(),
  handoff: z.string(),
});

export interface TaskFileMeta {
  taskId: string;
  title: string;
}

function renderBulletList(items: string[]): string {
  if (items.length === 0) return '_None yet._';
  return items.map((item) => `- ${item}`).join('\n');
}

// Pure string builder — the markdown body below a Task File's frontmatter.
// Every section but "Task Notes" holds only the latest snapshot; "Task
// Notes" is the one place with real per-run history (one "### Run N" per
// state.notes[i], 1-based). See GLOSSARY.md § Task Files.
export function renderTaskStateToMarkdown(state: TaskState, meta: TaskFileMeta): string {
  const notesSections =
    state.notes.length === 0
      ? '_No runs yet._'
      : state.notes
          .map((segment, i) => `### Run ${i + 1}\n\n${renderBulletList(segment)}`)
          .join('\n\n');

  const body = [
    `# Task: ${meta.title}`,
    '',
    '## Task Goal',
    '',
    state.goal || '_Not yet generated._',
    '',
    '## Previous Tasks',
    '',
    renderBulletList(state.previousTasks),
    '',
    '## Task Notes',
    '',
    notesSections,
    '',
    '## Task Outcome',
    '',
    state.outcome || '_This task has not finished a run yet._',
    '',
    '## Handoff Notes',
    '',
    state.handoff || '_None yet._',
    '',
  ].join('\n');

  return matter.stringify(body, state as unknown as Record<string, unknown>);
}

// Throws on missing/invalid frontmatter — callers (loadTaskState) decide
// what "invalid" means. Never parses the body; the body is a rendering of
// the frontmatter, not a second source of truth.
export function parseTaskStateFromMarkdown(raw: string): TaskState {
  const { data } = matter(raw);
  return TaskStateSchema.parse(data);
}

export interface LoadTaskStateResult {
  state: TaskState;
  // true when the file was missing or its frontmatter couldn't be parsed —
  // the caller is expected to record a visible note about this rather than
  // silently starting over (per the grilling session's history-gap answer).
  historyGap: boolean;
}

// ENOENT, or a corrupt/missing frontmatter, both degrade to an empty state
// rather than throwing — a Task File is a convenience artifact, never a
// reason to fail a task run. Mirrors loadWorkspaceSummaries's own
// ENOENT-tolerant shape (workspace-chat-stream-handler.ts).
export async function loadTaskState(filePath: string): Promise<LoadTaskStateResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('task-file: failed to read Task File, starting from empty state', {
        filePath,
        err: serializeError(err),
      });
    }
    return { state: cloneEmptyTaskState(), historyGap: true };
  }

  try {
    return { state: parseTaskStateFromMarkdown(raw), historyGap: false };
  } catch (err) {
    logger.warn('task-file: Task File frontmatter is unreadable, starting from empty state', {
      filePath,
      err: serializeError(err),
    });
    return { state: cloneEmptyTaskState(), historyGap: true };
  }
}

// Atomic write (temp file + rename), same pattern as
// lib/amazing-hashbrown-widgets/src/store.ts's writeFileAtomic — copied
// rather than imported, since api/ depending on the dashboard-widgets
// library for unrelated task data is the wrong semantic home (ADR-0037).
export async function writeTaskFile(
  filePath: string,
  state: TaskState,
  meta: TaskFileMeta,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, renderTaskStateToMarkdown(state, meta), 'utf8');
  await rename(tmpPath, filePath);
}

// Fixed-width (14 digits, no separators) so a Task File's filename sorts
// chronologically and so listWorkspaceTaskFiles can slice off the task id
// unambiguously even though a task's own UUID id itself contains hyphens.
export function formatTaskFileTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

const TASK_FILE_TIMESTAMP_WIDTH = 14;

export interface WorkspaceTaskFileSummary {
  taskId: string;
  goal: string;
  outcome: string;
  createdAt: string;
}

// Lists every Task File in a workspace's .hashbrown/tasks/ directory,
// newest-last (filenames sort chronologically by construction). Tolerates
// a missing directory (→ []) and skips (logs, doesn't throw) any one file
// that fails to parse, so one bad file never takes down the whole listing.
// Both `goal` and `outcome` are returned because the two call sites read
// different fields off the same result: the Previous Tasks section renders
// `outcome` (ADR-0038), the workspace-chat manifest renders `goal`.
export async function listWorkspaceTaskFiles(
  workspaceLocation: string,
  excludeTaskId: string,
): Promise<WorkspaceTaskFileSummary[]> {
  const dir = path.join(workspaceLocation, '.hashbrown', 'tasks');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('task-file: failed to list Task Files directory', {
        workspaceLocation,
        err: serializeError(err),
      });
    }
    return [];
  }

  const results: WorkspaceTaskFileSummary[] = [];
  for (const file of files) {
    // "<14-digit timestamp>-<taskId>.md" — sliced, not split on '-', since
    // a task's own UUID id contains hyphens itself.
    const timestamp = file.slice(0, TASK_FILE_TIMESTAMP_WIDTH);
    const taskId = file.slice(TASK_FILE_TIMESTAMP_WIDTH + 1, -'.md'.length);
    if (!taskId || taskId === excludeTaskId) continue;

    try {
      const raw = await readFile(path.join(dir, file), 'utf8');
      const state = parseTaskStateFromMarkdown(raw);
      results.push({ taskId, goal: state.goal, outcome: state.outcome, createdAt: timestamp });
    } catch (err) {
      logger.warn('task-file: skipping unreadable Task File in listing', {
        workspaceLocation,
        file,
        err: serializeError(err),
      });
    }
  }
  return results;
}
