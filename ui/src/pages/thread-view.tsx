import { useSignal } from '@preact/signals';
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
  sendMessage,
  submitHitlAnswer,
  stopGeneration,
  retryTurn,
  forkThread,
} from '@/hooks/use-thread';

export function ThreadView() {
  const inputValue = useSignal('');

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

  // Pending HITL is shown pinned below the scroll area, not in the message list
  const scrollMessages = allMessages.filter(
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
              onHitlAnswer={submitHitlAnswer}
              onRetry={retryTurn}
              onFork={(seq) => forkThread(activeThreadId.value, seq)}
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
        />
        <AfterAgentIndicator state={activeThreadAfterAgentState.value} showLabel className="mt-2" />
      </div>
    </div>
  );
}
