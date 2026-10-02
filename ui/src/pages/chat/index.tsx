import { AfterAgentIndicator } from '@/components/after-agent-indicator';
import { ChatInput, type StagedAttachment } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { Layout } from '@/components/layout';
import { ThreadMessageItem } from '@/components/thread-message';
import { favoriteModels, fetchProviders, providers } from '@/hooks/use-providers';
import {
  activeThreadAfterAgentState,
  activeThreadId,
  forkThread,
  refreshThreadList,
  switchThread,
  threads,
  useThreadInstance,
} from '@/hooks/use-thread';
import { useTitle } from '@/hooks/use-title';
import { useComputed, useSignal } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { TaskRunView } from './task-run-view';

export function ThreadView() {
  const { route } = useLocation();
  const { setPageTitle } = useTitle();
  const inputValue = useSignal('');
  const stagedAttachment = useSignal<StagedAttachment | null>(null);
  const forceScrollTrigger = useSignal(0);
  const thread = useThreadInstance(activeThreadId.value);

  const threadTitle = useComputed(
    () => threads.value.find((t) => t.id === activeThreadId.value)?.title,
  );

  useEffect(() => {
    setPageTitle(threadTitle.value ?? 'Chat');
  }, [threadTitle.value]);

  useEffect(() => {
    void fetchProviders();
  }, []);

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    forceScrollTrigger.value++;
    inputValue.value = '';
    const attachmentId = stagedAttachment.value?.id;
    stagedAttachment.value = null;
    thread.sendMessage(content, attachmentId).catch(console.error);
  }

  const allMessages = thread.messages.value;
  const pendingHitlMsg = thread.pendingHitlId.value
    ? allMessages.find((m) => m.kind === 'hitl_prompt' && m.promptId === thread.pendingHitlId.value)
    : null;

  // Pending HITL is shown pinned below the scroll area, not in the message list
  const scrollMessages = thread.displayMessages.value.filter(
    (m) => !(m.kind === 'hitl_prompt' && m.status === 'pending'),
  );

  return (
    <div class="flex h-full flex-col">
      <ChatMessageScrollWrapper
        className="min-h-0 flex-1"
        forceScrollTrigger={forceScrollTrigger.value}
      >
        <div class="flex flex-col gap-4 p-4 pb-2">
          {scrollMessages.map((msg) => (
            <ThreadMessageItem
              key={msg.id}
              message={msg}
              threadId={activeThreadId.value}
              onHitlAnswer={thread.submitHitlAnswer}
              onRetry={thread.retryTurn}
              onFork={(seq) =>
                void forkThread(activeThreadId.value, seq).then((id) => route(`/chat/${id}`))
              }
            />
          ))}
        </div>
      </ChatMessageScrollWrapper>

      {pendingHitlMsg && pendingHitlMsg.kind === 'hitl_prompt' && (
        <div class="border-t border-border p-4">
          <HitlPromptMessage message={pendingHitlMsg} onAnswer={thread.submitHitlAnswer} />
        </div>
      )}

      {thread.isWaitingForProvider.value && (
        <div class="border-t border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          Waiting for {thread.waitingProviderName.value} to have capacity…
        </div>
      )}

      {thread.backgroundTurnActive.value && (
        <div
          data-testid="background-turn-status"
          class="border-t border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          The agent is working in the background…
        </div>
      )}

      <div class="border-t border-border p-4">
        <ChatInput
          value={inputValue.value}
          onValueChange={(v) => {
            inputValue.value = v;
          }}
          onSend={handleSend}
          onStop={thread.stopGeneration}
          isGenerating={thread.isStreaming.value || thread.backgroundTurnActive.value}
          disabled={!!thread.pendingHitlId.value}
          providers={providers.value}
          favoriteModels={favoriteModels.value}
          activeProvider={thread.activeThreadModel.value?.provider}
          activeModel={thread.activeThreadModel.value?.model}
          onModelSelect={thread.setThreadModel}
          threadId={activeThreadId.value}
          attachment={stagedAttachment.value}
          onAttachmentChange={(attachment) => {
            stagedAttachment.value = attachment;
          }}
        />
        <AfterAgentIndicator state={activeThreadAfterAgentState.value} showLabel className="mt-2" />
      </div>
    </div>
  );
}

export function ChatRoot({ id }: { path?: string; id?: string }) {
  // 'chat' renders the normal chat view; 'run' the read-only view of an
  // automated task run; 'resolving' is the brief check in between.
  const mode = useSignal<'chat' | 'run' | 'resolving'>('chat');

  useEffect(() => {
    refreshThreadList();
  }, []);

  useEffect(() => {
    if (!id) return;
    // A thread already in the chat list is a chat — switch straight to it.
    // Anything else is checked first: an automated run's thread opens
    // read-only and must never become the persisted active chat thread
    // (switchThread's side effect), or the app would reopen it on the
    // next visit.
    if (threads.value.some((t) => t.id === id)) {
      mode.value = 'chat';
      void switchThread(id);
      return;
    }
    let cancelled = false;
    mode.value = 'resolving';
    const instance = useThreadInstance(id);
    void instance.hydrate().then(() => {
      if (cancelled) return;
      if (instance.threadType.value === 'task') {
        mode.value = 'run';
      } else {
        mode.value = 'chat';
        void switchThread(id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <Layout addLabel="New conversation">
      {mode.value === 'run' && id ? (
        <TaskRunView threadId={id} />
      ) : mode.value === 'resolving' ? (
        <div class="h-full" />
      ) : (
        <ThreadView />
      )}
    </Layout>
  );
}
