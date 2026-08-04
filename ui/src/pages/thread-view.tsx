import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ChatInput } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { ThreadMessageItem } from '@/components/thread-message';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { AfterAgentIndicator } from '@/components/after-agent-indicator';
import {
  messages,
  isStreaming,
  pendingHitlId,
  activeThreadId,
  activeThreadAfterAgentState,
  activeThreadModel,
  sendMessage,
  submitHitlAnswer,
  stopGeneration,
  retryTurn,
  forkThread,
  setThreadModel,
} from '@/hooks/use-thread';
import { providers, fetchProviders } from '@/hooks/use-providers';
import type { ThreadMessage } from '@/types/thread-message';

// Tool calls execute before the assistant produces its final text response, but
// the flat messages array stores them after the assistant item (because the
// assistant item is inserted eagerly at turn start to show streaming state).
// This reorders tool_call items that immediately follow an assistant item to
// appear before it, matching actual execution order.
function reorderMessagesForDisplay(msgs: ThreadMessage[]): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const msg = msgs[i]!;
    if (msg.kind === 'assistant') {
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
  const inputValue = useSignal('');

  useEffect(() => {
    void fetchProviders();
  }, []);

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    inputValue.value = '';
    sendMessage(content).catch(console.error);
  }

  const allMessages = messages.value;
  const pendingHitlMsg = pendingHitlId.value
    ? allMessages.find((m) => m.kind === 'hitl_prompt' && m.promptId === pendingHitlId.value)
    : null;

  // Resolve the active provider/model for display: thread selection → provider default → first available
  const resolvedProvider =
    activeThreadModel.value?.provider ??
    providers.value.find((p) => p.defaultModel)?.name ??
    providers.value[0]?.name;
  const resolvedModel =
    activeThreadModel.value?.model ??
    providers.value.find((p) => p.name === resolvedProvider)?.defaultModel ??
    providers.value[0]?.models[0]?.id;

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
              onHitlAnswer={submitHitlAnswer}
              onRetry={retryTurn}
              onFork={(seq) =>
                void forkThread(activeThreadId.value, seq).then((id) => route(`/chat/${id}`))
              }
            />
          ))}
        </div>
      </ChatMessageScrollWrapper>

      {pendingHitlMsg && pendingHitlMsg.kind === 'hitl_prompt' && (
        <div class="border-t border-border p-4">
          <HitlPromptMessage message={pendingHitlMsg} onAnswer={submitHitlAnswer} />
        </div>
      )}

      <div class="border-t border-border p-4">
        <ChatInput
          value={inputValue.value}
          onValueChange={(v) => {
            inputValue.value = v;
          }}
          onSend={handleSend}
          onStop={stopGeneration}
          isGenerating={isStreaming.value}
          disabled={!!pendingHitlId.value}
          providers={providers.value}
          activeProvider={resolvedProvider}
          activeModel={resolvedModel}
          onModelSelect={setThreadModel}
        />
        <AfterAgentIndicator state={activeThreadAfterAgentState.value} showLabel className="mt-2" />
      </div>
    </div>
  );
}
