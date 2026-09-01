import { AfterAgentIndicator } from '@/components/after-agent-indicator';
import { ChatInput } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { Layout } from '@/components/layout';
import { ThreadMessageItem } from '@/components/thread-message';
import { fetchProviders, providers } from '@/hooks/use-providers';
import {
  activeThreadAfterAgentState,
  activeThreadId,
  forkThread,
  refreshThreadList,
  switchThread,
  useThreadInstance,
} from '@/hooks/use-thread';
import { useSignal } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

export function ThreadView() {
  const { route } = useLocation();
  const inputValue = useSignal('');
  const thread = useThreadInstance(activeThreadId.value);

  useEffect(() => {
    void fetchProviders();
  }, []);

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    inputValue.value = '';
    thread.sendMessage(content).catch(console.error);
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
      <ChatMessageScrollWrapper className="min-h-0 flex-1">
        <div class="flex flex-col gap-4 p-4 pb-2">
          {scrollMessages.map((msg) => (
            <ThreadMessageItem
              key={msg.id}
              message={msg}
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

      <div class="border-t border-border p-4">
        <ChatInput
          value={inputValue.value}
          onValueChange={(v) => {
            inputValue.value = v;
          }}
          onSend={handleSend}
          onStop={thread.stopGeneration}
          isGenerating={thread.isStreaming.value}
          disabled={!!thread.pendingHitlId.value}
          providers={providers.value}
          activeProvider={thread.activeThreadModel.value?.provider}
          activeModel={thread.activeThreadModel.value?.model}
          onModelSelect={thread.setThreadModel}
        />
        <AfterAgentIndicator state={activeThreadAfterAgentState.value} showLabel className="mt-2" />
      </div>
    </div>
  );
}

export function ChatRoot({ id }: { path?: string; id?: string }) {
  useEffect(() => {
    refreshThreadList();
  }, []);

  useEffect(() => {
    if (id) void switchThread(id);
  }, [id]);

  return (
    <Layout addLabel="New conversation">
      <ThreadView />
    </Layout>
  );
}
