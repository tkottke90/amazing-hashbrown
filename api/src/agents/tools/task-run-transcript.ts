import type { ThreadStore } from '../../services/thread-store.js';
import type { TaskRun } from '../../services/workspace-store.js';
import { transcriptLine } from '../thread-text.js';

// Enough to read any real run in full — getThreadMessages() otherwise
// returns only the newest 200 rows.
const MAX_RUN_MESSAGES = 10_000;

export const FINISHED_RUN_STATUSES: ReadonlySet<TaskRun['status']> = new Set([
  'done',
  'failed',
  'cancelled',
  'handed_off',
]);

// Shared by read-task-run.tool.ts (a task reading its own history) and
// read-workspace-task-run.tool.ts (workspace chat reading any task's
// history) — the two differ only in how they resolve/validate which run to
// read, not in how a resolved, finished run's transcript gets paginated and
// formatted. Callers are responsible for the FINISHED_RUN_STATUSES gate and
// the pre-transcript (no threadId) fallback before calling this.
export function formatRunTranscript(
  threadStore: ThreadStore,
  run: TaskRun,
  offset: number,
  limit: number,
): string {
  const lines = threadStore
    .getThreadMessages(run.threadId as string, { limit: MAX_RUN_MESSAGES })
    .filter((m) => !m.superseded)
    .map(transcriptLine)
    .filter((line): line is string => line !== null);

  const header = `Transcript of run #${run.runNumber} (${run.status}, started via ${run.triggerSource}):`;
  if (lines.length === 0) return `${header}\n(no messages recorded)`;
  if (offset >= lines.length) {
    return `${header}\n(offset ${offset} is past the end — this run has ${lines.length} messages)`;
  }

  const page = lines.slice(offset, offset + limit);
  const last = offset + page.length;
  const footer =
    last < lines.length
      ? `(messages ${offset + 1}–${last} of ${lines.length}; call again with offset=${last} for more)`
      : `(messages ${offset + 1}–${last} of ${lines.length}; end of transcript)`;
  return [header, ...page, footer].join('\n');
}
