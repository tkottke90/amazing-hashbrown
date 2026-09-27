import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ArrowLeft, Lock } from 'lucide-preact';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { ThreadMessageItem } from '@/components/thread-message';
import { CardBadge } from '@/components/card-badge';
import { Button } from '@/components/ui/button';
import { useThreadInstance } from '@/hooks/use-thread';
import { useTitle } from '@/hooks/use-title';
import { runName, triggerSourceLabel } from '@/lib/task-runs';

// A run's transcript refreshes on the task lifecycle events use-live-events
// already rehydrates on (start, completion, a question); in between, a
// running run has no live stream to a browser, so this polls instead.
const RUNNING_POLL_MS = 4000;

const STATUS_BADGE: Record<string, 'blue' | 'green' | 'amber' | 'violet'> = {
  pending: 'blue',
  running: 'blue',
  paused: 'amber',
  done: 'green',
  failed: 'amber',
  cancelled: 'violet',
};

// The read-only record of one automated task run, shown when a 'task'
// thread is opened at /chat/:id (see ChatRoot). A run is what the agent
// did, not a conversation: there is no message box, retry or fork — the
// only interactive thing is the run's own question card, answered through
// the chat /hitl route, which re-queues the task. See
// docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §4.
export function TaskRunView({ threadId }: { threadId: string }) {
  const { route } = useLocation();
  const { setPageTitle } = useTitle();
  const thread = useThreadInstance(threadId);
  const run = thread.taskRun.value;
  const isLive = run?.status === 'running' || run?.status === 'pending';

  useEffect(() => {
    setPageTitle(run ? `${runName(run.runNumber, run.triggerSource)} · ${run.taskTitle}` : 'Run');
  }, [run?.runNumber, run?.taskTitle]);

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => void thread.hydrate(), RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [threadId, isLive]);

  const pendingHitl = thread.pendingHitlId.value
    ? thread.messages.value.find(
        (m) => m.kind === 'hitl_prompt' && m.promptId === thread.pendingHitlId.value,
      )
    : null;
  const scrollMessages = thread.displayMessages.value.filter(
    (m) => !(m.kind === 'hitl_prompt' && m.status === 'pending'),
  );

  return (
    <div class="flex h-full flex-col" data-testid="task-run-view">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="xs"
          data-testid="task-run-back"
          onClick={() => route(run?.workspaceId ? `/workspaces/${run.workspaceId}` : '/inbox')}
        >
          <ArrowLeft class="size-3.5" />
          {run?.workspaceId ? 'Workspace' : 'Inbox'}
        </Button>
        <h1 class="text-sm font-medium" data-testid="task-run-title">
          {run ? (
            <>
              {runName(run.runNumber, run.triggerSource)} of{' '}
              <span class="text-foreground">{run.taskTitle}</span>
            </>
          ) : (
            'Automated run'
          )}
        </h1>
        {run && (
          <>
            <CardBadge variant={STATUS_BADGE[run.status] ?? 'blue'}>
              <span data-testid="task-run-status">{run.status}</span>
            </CardBadge>
            <CardBadge variant="violet">{triggerSourceLabel(run.triggerSource)}</CardBadge>
          </>
        )}
      </header>

      <ChatMessageScrollWrapper className="min-h-0 flex-1">
        <div class="flex flex-col gap-4 p-4 pb-2">
          {scrollMessages.map((msg) => (
            // No onRetry/onFork: ThreadMessageItem hides both actions.
            <ThreadMessageItem key={msg.id} message={msg} onHitlAnswer={thread.submitHitlAnswer} />
          ))}
        </div>
      </ChatMessageScrollWrapper>

      {pendingHitl && pendingHitl.kind === 'hitl_prompt' && (
        <div class="border-t border-border p-4">
          <HitlPromptMessage message={pendingHitl} onAnswer={thread.submitHitlAnswer} />
        </div>
      )}

      <footer
        class="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground"
        data-testid="task-run-readonly-note"
      >
        <Lock class="size-3.5 shrink-0" />
        This is a read-only record of an automated run.
      </footer>
    </div>
  );
}
