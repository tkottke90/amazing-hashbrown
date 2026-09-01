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
  threads,
  useThreadInstance,
} from '@/hooks/use-thread';
import { useTitle } from '@/hooks/use-title';
import type { ThreadMessage } from '@/types/thread-message';
import { useComputed, useSignal } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

// A turn's assistant bubble is inserted eagerly at turn start (empty, to
// show the loading state immediately) before any tool call has fired. If a
// tool call happens before any text arrives, that empty placeholder is
// still positioned ahead of it in the flat array — this reorders a
// still-empty assistant item's immediately-following tool_call run to
// appear before it, matching actual execution order. Once an assistant
// item has real content, its position already reflects when that text was
// actually streamed relative to any tool calls (use-thread.ts starts a new
// bubble for text after a mid-turn tool call rather than merging it into
// earlier text), so it's left in place.
function reorderMessagesForDisplay(msgs: ThreadMessage[]): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const msg = msgs[i]!;
    if (msg.kind === 'assistant' && msg.content.length === 0) {
      const toolCalls: ThreadMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j]!.kind === 'tool_call') {
        toolCalls.push(msgs[j]!);
        j++;
      }
      result.push(...toolCalls, msg);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

export function ThreadView() {
  const { route } = useLocation();
  const { setPageTitle } = useTitle();
  const inputValue = useSignal('');
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
    inputValue.value = '';
    thread.sendMessage(content).catch(console.error);
  }

  const allMessages = thread.messages.value;
  const pendingHitlMsg = thread.pendingHitlId.value
    ? allMessages.find((m) => m.kind === 'hitl_prompt' && m.promptId === thread.pendingHitlId.value)
    : null;

  // Pending HITL is shown pinned below the scroll area, not in the message list
  const scrollMessages = reorderMessagesForDisplay(
    allMessages.filter((m) => !(m.kind === 'hitl_prompt' && m.status === 'pending')),
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
