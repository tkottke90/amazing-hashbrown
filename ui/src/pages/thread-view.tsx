import { useSignal } from '@preact/signals';
import { ChatInput } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { ThreadMessageItem } from '@/components/thread-message';
import {
  messages,
  isStreaming,
  pendingHitlId,
  sendMessage,
  submitHitlAnswer,
  stopGeneration,
} from '@/hooks/use-thread';

export function ThreadView() {
  const inputValue = useSignal('');

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    inputValue.value = '';
    sendMessage(content).catch(console.error);
  }

  return (
    <div class="flex h-full flex-col">
      <ChatMessageScrollWrapper className="min-h-0 flex-1">
        <div class="flex flex-col gap-4 p-4 pb-2">
          {messages.value.map((msg) => (
            <ThreadMessageItem
              key={msg.id}
              message={msg}
              onHitlAnswer={submitHitlAnswer}
            />
          ))}
        </div>
      </ChatMessageScrollWrapper>

      <div class="border-t border-border p-4">
        <ChatInput
          value={inputValue.value}
          onValueChange={(v) => { inputValue.value = v; }}
          onSend={handleSend}
          onStop={stopGeneration}
          isGenerating={isStreaming.value}
          disabled={!!pendingHitlId.value}
        />
      </div>
    </div>
  );
}
