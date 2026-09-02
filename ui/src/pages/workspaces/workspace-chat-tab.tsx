import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { ChatInput, type StagedAttachment } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { ThreadMessageItem } from '@/components/thread-message';
import { Button } from '@/components/ui/button';
import { fetchProviders, providers } from '@/hooks/use-providers';
import { useThreadInstance } from '@/hooks/use-thread';
import { patchWorkspace, refreshWorkspaces } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';
import { randomUUID } from '@/lib/utils';

export function WorkspaceChatTab({ workspace }: { workspace: Workspace }) {
  const inputValue = useSignal('');
  const stagedAttachment = useSignal<StagedAttachment | null>(null);
  // Local, button-driven loading state for the on-demand summarize request —
  // distinct from thread.isSummarizing (SSE-driven, only fires for the
  // automatic in-turn path), so both trigger paths show the same disabled/
  // "Summarising…" treatment even though only one rides the chat stream.
  const manualSummarizing = useSignal(false);

  useEffect(() => {
    void fetchProviders();
  }, []);

  useEffect(() => {
    if (workspace.threadId) return;
    const id = randomUUID();
    void patchWorkspace(workspace.id, { threadId: id }).then(() => void refreshWorkspaces());
  }, [workspace.id, workspace.threadId]);

  if (!workspace.threadId) return null; // brief flash while the PATCH above resolves

  const thread = useThreadInstance(workspace.threadId, {
    endpointBase: `/api/v1/workspaces/${workspace.id}/chat`,
    readUrl: `/api/v1/workspaces/${workspace.id}/chat/${workspace.threadId}`,
  });

  // Runs once per mounted instance — hydrate() is idempotent to call again
  // on a later remount of the same thread id (e.g. navigating tabs and back).
  useEffect(() => {
    void thread.hydrate();
  }, [workspace.threadId]);

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    inputValue.value = '';
    const attachmentId = stagedAttachment.value?.id;
    stagedAttachment.value = null;
    thread.sendMessage(content, attachmentId).catch(console.error);
  }

  async function handleSummarizeClick() {
    manualSummarizing.value = true;
    try {
      await fetch(`/api/v1/workspaces/${workspace.id}/chat/${workspace.threadId}/summarize`, {
        method: 'POST',
      });
      await thread.hydrate();
    } finally {
      manualSummarizing.value = false;
    }
  }

  const isBusy = thread.isSummarizing.value || manualSummarizing.value;
  const allMessages = thread.messages.value;
  const pendingHitlMsg = thread.pendingHitlId.value
    ? allMessages.find((m) => m.kind === 'hitl_prompt' && m.promptId === thread.pendingHitlId.value)
    : null;
  const scrollMessages = thread.displayMessages.value.filter(
    (m) => !(m.kind === 'hitl_prompt' && m.status === 'pending'),
  );

  return (
    <div class="p-4 size-full" data-id="chat_boundary">
      <div class="flex flex-col overflow-hidden rounded-xl border border-border size-full">
        {thread.isPaused.value && (
          <div class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            Task queue paused while this chat is active
          </div>
        )}

        {thread.summaryPath.value && (
          <div class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            Earlier messages were summarised —{' '}
            <a
              href={`/api/v1/workspaces/${workspace.id}/files/${thread.summaryPath.value}`}
              target="_blank"
              rel="noreferrer"
              class="underline"
            >
              view summary
            </a>
          </div>
        )}

        <ChatMessageScrollWrapper className="min-h-0 flex-1">
          <div class="flex flex-col gap-4 p-4 pb-2">
            {scrollMessages.map((msg) => (
              // onFork intentionally omitted — a workspace has one rolling
              // thread for its whole lifetime, not a forkable tree of
              // conversations like the global chat's.
              <ThreadMessageItem
                key={msg.id}
                message={msg}
                onHitlAnswer={thread.submitHitlAnswer}
                onRetry={thread.retryTurn}
              />
            ))}
          </div>
        </ChatMessageScrollWrapper>

        {pendingHitlMsg && pendingHitlMsg.kind === 'hitl_prompt' && (
          <div class="border-t border-border p-4">
            <HitlPromptMessage message={pendingHitlMsg} onAnswer={thread.submitHitlAnswer} />
          </div>
        )}

        <div class="border-t border-border p-3">
          <div class="mb-2 flex items-center justify-between">
            {isBusy ? <span class="text-xs text-muted-foreground">Summarising…</span> : <span />}
            <Button
              size="sm"
              variant="secondary"
              disabled={isBusy}
              onClick={() => void handleSummarizeClick()}
            >
              Summarise
            </Button>
          </div>
          <ChatInput
            value={inputValue.value}
            onValueChange={(v) => {
              inputValue.value = v;
            }}
            onSend={handleSend}
            onStop={thread.stopGeneration}
            isGenerating={thread.isStreaming.value}
            disabled={!!thread.pendingHitlId.value || isBusy}
            providers={providers.value}
            activeProvider={thread.activeThreadModel.value?.provider}
            activeModel={thread.activeThreadModel.value?.model}
            onModelSelect={thread.setThreadModel}
            threadId={workspace.threadId}
            onAttachmentChange={(attachment) => {
              stagedAttachment.value = attachment;
            }}
          />
        </div>
      </div>
    </div>
  );
}
