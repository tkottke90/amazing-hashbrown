import { useEffect } from 'preact/hooks';
import { ArrowLeft, Lock } from 'lucide-preact';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { ThreadMessageItem } from '@/components/thread-message';
import { CardBadge } from '@/components/card-badge';
import { Button } from '@/components/ui/button';
import { ThreadReportButton } from '@/components/thread-report-button';
import { useThreadInstance } from '@/hooks/use-thread';
import { useTitle } from '@/hooks/use-title';

// The read-only record of an Archived Thread (GLOSSARY.md), shown when a
// 'chat' thread with a non-null archivedAt is opened at /chat/:id (see
// ChatRoot). Structurally modeled on TaskRunView — self-contained, takes
// threadId as a prop, never touches activeThreadId/switchThread — but
// without any task-run-specific metadata, since this is an ordinary chat
// thread that just happens to be frozen. See
// docs/adr/0029-archived-thread-view-is-not-threadview.md.
export function ArchivedThreadView({ threadId }: { threadId: string }) {
  const { setPageTitle } = useTitle();
  const thread = useThreadInstance(threadId);

  useEffect(() => {
    setPageTitle(thread.title.value ?? 'Archived thread');
  }, [thread.title.value]);

  const pendingHitl = thread.pendingHitlId.value
    ? thread.messages.value.find(
        (m) => m.kind === 'hitl_prompt' && m.promptId === thread.pendingHitlId.value,
      )
    : null;
  const scrollMessages = thread.displayMessages.value.filter(
    (m) => !(m.kind === 'hitl_prompt' && m.status === 'pending'),
  );

  return (
    <div class="flex h-full flex-col" data-testid="archived-thread-view">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            data-testid="archived-thread-back"
            onClick={() => window.history.back()}
          >
            <ArrowLeft class="size-3.5" />
            Back
          </Button>
          <h1 class="text-sm font-medium" data-testid="archived-thread-title">
            {thread.title.value ?? 'Archived thread'}
          </h1>
          <CardBadge variant="violet">Archived</CardBadge>
        </div>
        <div class="flex items-center gap-2">
          <ThreadReportButton threadId={threadId} />
        </div>
      </header>

      <ChatMessageScrollWrapper className="min-h-0 flex-1">
        <div class="flex flex-col gap-4 p-4 pb-2">
          {scrollMessages.map((msg) => (
            // No onRetry/onFork: ThreadMessageItem hides both actions. The
            // thread is read-only regardless — the backend 409s any of
            // chat/retry/fork/hitl-answer on an archived thread, so there
            // is no client-side blocking logic to add here either.
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
        data-testid="archived-thread-readonly-note"
      >
        <Lock class="size-3.5 shrink-0" />
        This thread is archived and read-only.
      </footer>
    </div>
  );
}
