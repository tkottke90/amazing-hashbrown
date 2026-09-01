import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Check, Download, Hash, RotateCcw } from 'lucide-preact';
import type { RefObject } from 'preact';
import { ChatInput } from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { ThreadMessageItem } from '@/components/thread-message';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import {
  wikiDisplayMessages,
  wikiIsStreaming,
  wikiPendingHitlId,
  wikiThreadId,
  sendWikiMessage,
  submitWikiHitlAnswer,
  stopWikiGeneration,
  retryWikiTurn,
  newWikiThread,
  activeWikiModel,
  setWikiModel,
} from '@/pages/wiki/use-wiki-ingestion';
import { providers, fetchProviders } from '@/hooks/use-providers';
import { OrientationBadge } from './orientation-badge';
import { NewDomainModal } from './new-domain-form';
import { UploadWikiDialog } from './upload-wiki-form';

interface Props {
  chatInputRef?: RefObject<HTMLTextAreaElement>;
}

export function IngestionChat({ chatInputRef }: Props) {
  const inputValue = useSignal('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const copied = useSignal(false);

  function handleCopyThreadId() {
    void navigator.clipboard.writeText(wikiThreadId.value).then(() => {
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 2000);
    });
  }

  useEffect(() => {
    void fetchProviders();
  }, []);

  // Assign the inner textarea to chatInputRef so DocumentView can focus it after save
  useEffect(() => {
    if (!chatInputRef || !wrapperRef.current) return;
    const ta = wrapperRef.current.querySelector<HTMLTextAreaElement>(
      '[data-slot="chat-input"] textarea',
    );
    if (ta) {
      (chatInputRef as { current: HTMLTextAreaElement | null }).current = ta;
    }
  }, [chatInputRef]);

  function handleSend() {
    const content = inputValue.value.trim();
    if (!content) return;
    inputValue.value = '';
    void sendWikiMessage(content);
  }

  const resolvedProvider =
    activeWikiModel.value?.provider ??
    providers.value.find((p) => p.defaultModel)?.name ??
    providers.value[0]?.name;
  const resolvedModel =
    activeWikiModel.value?.model ??
    providers.value.find((p) => p.name === resolvedProvider)?.defaultModel ??
    providers.value[0]?.models[0]?.id;

  const allMessages = wikiDisplayMessages.value;
  const pendingHitlId = wikiPendingHitlId.value;
  const pendingHitlMsg = pendingHitlId
    ? allMessages.find((m) => m.kind === 'hitl_prompt' && m.promptId === pendingHitlId)
    : null;

  const scrollMessages = allMessages.filter(
    (m) => !(m.kind === 'hitl_prompt' && m.status === 'pending'),
  );

  return (
    <div class="flex h-full min-h-0 flex-col border-l border-border">
      {/* Header */}
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="text-xs font-semibold text-foreground">Wiki Chat</span>
          <OrientationBadge />
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <NewDomainModal />
          <UploadWikiDialog />
          <button
            type="button"
            onClick={() => window.open(`/api/v1/threads/${wikiThreadId.value}/report`, '_blank')}
            title="Generate thread report"
            class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
          >
            <Download class="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopyThreadId}
            title="Copy thread ID"
            class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
          >
            {copied.value ? <Check class="size-3.5" /> : <Hash class="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={newWikiThread}
            title="New conversation"
            class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
          >
            <RotateCcw class="size-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <ChatMessageScrollWrapper className="min-h-0 flex-1">
        <div class="flex flex-col gap-4 p-4 pb-2">
          {scrollMessages.map((msg) => (
            <ThreadMessageItem
              key={msg.id}
              message={msg}
              onHitlAnswer={submitWikiHitlAnswer}
              onRetry={retryWikiTurn}
            />
          ))}
        </div>
      </ChatMessageScrollWrapper>

      {/* Pinned HITL prompt */}
      {pendingHitlMsg && pendingHitlMsg.kind === 'hitl_prompt' && (
        <div class="border-t border-border p-3">
          <HitlPromptMessage message={pendingHitlMsg} onAnswer={submitWikiHitlAnswer} />
        </div>
      )}

      {/* Input */}
      <div ref={wrapperRef} class="shrink-0 border-t border-border p-3">
        <ChatInput
          value={inputValue.value}
          onValueChange={(v) => {
            inputValue.value = v;
          }}
          placeholder="Add to the wiki..."
          onSend={handleSend}
          onStop={stopWikiGeneration}
          isGenerating={wikiIsStreaming.value}
          disabled={!!pendingHitlId}
          providers={providers.value}
          activeProvider={resolvedProvider}
          activeModel={resolvedModel}
          onModelSelect={setWikiModel}
        />
      </div>
    </div>
  );
}
