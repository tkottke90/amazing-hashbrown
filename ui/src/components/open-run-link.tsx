import { useLocation } from 'preact-iso';
import { runPath } from '@/lib/task-runs';

interface OpenRunLinkProps {
  runThreadId: string | undefined;
  // Each caller keeps its own, already-documented test id (e.g.
  // TaskRunMarkerMessage's existing "task-run-marker-open") rather than this
  // component imposing a shared one, so extracting this doesn't break an
  // existing Playwright selector.
  testId: string;
}

// Shared by any marker that brackets a Run (TaskRunMarkerMessage,
// SubAgentMarkerMessage): renders nothing when there's no run thread to
// link to, or when we're already on that run's own page.
export function OpenRunLink({ runThreadId, testId }: OpenRunLinkProps) {
  const { path, route } = useLocation();
  const openRun = runThreadId && path !== runPath(runThreadId) ? runThreadId : null;
  if (!openRun) return null;

  return (
    <button
      type="button"
      data-testid={testId}
      className="underline underline-offset-2 hover:text-foreground"
      onClick={() => route(runPath(openRun))}
    >
      Open run
    </button>
  );
}
