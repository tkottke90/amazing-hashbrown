import type { LintFinding, LintReport } from '@tkottke90/llm-wiki';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadStage =
  | 'pending'
  | 'unpacking'
  | 'validating'
  | 'registering'
  | 'linting'
  | 'embedding'
  | 'done'
  | 'failed';

export type UploadJobState =
  | { stage: 'pending' | 'unpacking' | 'validating' | 'registering' | 'linting' }
  | { stage: 'embedding'; pagesEmbedded: number; pagesTotal: number }
  | { stage: 'done'; wikiId: string; lintReport: LintReport }
  | { stage: 'failed'; error: string; findings?: LintFinding[] };

interface JobEntry {
  state: UploadJobState;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const jobs = new Map<string, JobEntry>();

/** Register a new job in the pending state. */
export function createUploadJob(jobId: string): void {
  jobs.set(jobId, { state: { stage: 'pending' }, createdAt: Date.now() });
  scheduleEviction(jobId);
}

/** Replace the job's state. */
export function setUploadState(jobId: string, state: UploadJobState): void {
  const entry = jobs.get(jobId);
  if (!entry) return;
  entry.state = state;
}

/** Return the current state, or null if the jobId is unknown / evicted. */
export function getUploadState(jobId: string): UploadJobState | null {
  return jobs.get(jobId)?.state ?? null;
}

function scheduleEviction(jobId: string): void {
  setTimeout(() => jobs.delete(jobId), TTL_MS).unref();
}
