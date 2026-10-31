import { AfterAgentIndicator } from '@/components/after-agent-indicator';
import { ChatInput, type StagedAttachment } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { Layout } from '@/components/layout';
import { ThreadMessageItem } from '@/components/thread-message';
import {
  favoriteModels,
  fetchProviders,
  providers,
  type FavoriteModel,
  type ProviderInfo,
} from '@/hooks/use-providers';
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
import { useComputed, useSignal, type Signal } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { TaskRunView } from './task-run-view';
import { ArchivedThreadView } from './archived-thread-view';

// Its own subcomponent so a keystroke here (which only flips `inputValue`)
// re-renders just the composer, not the whole thread view's message list —
// see ui/src/pages/workspaces/files-tab.tsx's `TabButton` for the same
// isolation pattern applied to a different signal.
function ChatComposer({
  inputValue,
  stagedAttachments,
  onSend,
  onStop,
  isGenerating,
  disabled,
  providers,
  favoriteModels,
  activeProvider,
  activeModel,
  onModelSelect,
  threadId,
}: {
  inputValue: Signal<string>;
  stagedAttachments: Signal<StagedAttachment[]>;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled: boolean;
  providers: ProviderInfo[];
  favoriteModels: FavoriteModel[];
  activeProvider?: string | null;
  activeModel?: string | null;
  onModelSelect: (provider: string, model: string) => void;
  threadId: string;
}) {
  return (
    <ChatInput
      value={inputValue.value}
      onValueChange={(v) => {
        inputValue.value = v;
      }}
      onSend={onSend}
      onStop={onStop}
      isGenerating={isGenerating}
      disabled={disabled}
      providers={providers}
      favoriteModels={favoriteModels}
      activeProvider={activeProvider}
      activeModel={activeModel}
      onModelSelect={onModelSelect}
      threadId={threadId}
      attachments={stagedAttachments.value}
      onAttachmentsChange={(next) => {
        stagedAttachments.value = next;
      }}
    />
  );
}

export function ThreadView() {
  const { route } = useLocation();
  const { setPageTitle } = useTitle();
  const inputValue = useSignal('');
  const stagedAttachments = useSignal<StagedAttachment[]>([]);
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
    const attachments = stagedAttachments.value;
    stagedAttachments.value = [];
    thread.sendMessage(content, attachments).catch(console.error);
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
        <ChatComposer
          inputValue={inputValue}
          stagedAttachments={stagedAttachments}
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
        />
        <AfterAgentIndicator state={activeThreadAfterAgentState.value} showLabel className="mt-2" />
      </div>
    </div>
  );
}

export function ChatRoot({ id }: { path?: string; id?: string }) {
  // 'chat' renders the normal chat view; 'run' the read-only view of an
  // automated task run; 'archived' the read-only view of an Archived
  // Thread (GLOSSARY.md); 'resolving' is the brief check in between.
  const mode = useSignal<'chat' | 'run' | 'archived' | 'resolving'>('chat');

  useEffect(() => {
    refreshThreadList();
  }, []);

  useEffect(() => {
    if (!id) return;
    // A thread already in the chat list is a chat — switch straight to it.
    // Anything else is checked first: an automated run's thread, and an
    // Archived Thread, both open read-only and must never become the
    // persisted active chat thread (switchThread's side effect), or the
    // app would reopen it on the next visit. This relies on the sidebar's
    // own fetch (threads, populated by refreshThreadList) already
    // excluding archived threads server-side (see threads.route.ts's GET
    // '/' — D13) — an archived thread should never match here.
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
      } else if (instance.archivedAt.value) {
        mode.value = 'archived';
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
      ) : mode.value === 'archived' && id ? (
        <ArchivedThreadView threadId={id} />
      ) : mode.value === 'resolving' ? (
        <div class="h-full" />
      ) : (
        <ThreadView />
      )}
    </Layout>
  );
}
