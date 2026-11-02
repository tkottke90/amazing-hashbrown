import { useEffect } from 'preact/hooks';
import { useSignal, useComputed, type Signal } from '@preact/signals';
import {
  ChatInput,
  stageWikiReference,
  type StagedAttachment,
  type StagedWikiReference,
} from '@/components/chat-input';
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { ThreadMessageItem } from '@/components/thread-message';
import { ThreadReportButton } from '@/components/thread-report-button';
import { Button } from '@/components/ui/button';
import {
  favoriteModels,
  fetchProviders,
  providers,
  type FavoriteModel,
  type ProviderInfo,
} from '@/hooks/use-providers';
import { useThreadInstance } from '@/hooks/use-thread';
import { patchWorkspace, refreshWorkspaces } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';
import { randomUUID } from '@/lib/utils';

// Its own subcomponent so a keystroke here (which only flips `inputValue`)
// re-renders just the composer, not the whole tab's message list — see
// ui/src/pages/workspaces/files-tab.tsx's `TabButton` for the same
// isolation pattern applied to a different signal.
function ChatComposer({
  inputValue,
  stagedAttachments,
  stagedWikiReferences,
  onSend,
  onStop,
  onFocus,
  onBlur,
  isGenerating,
  disabled,
  providers,
  favoriteModels,
  activeProvider,
  activeModel,
  onModelSelect,
  threadId,
  workspaceId,
  autoApproveShell,
  onToggleAutoApproveShell,
}: {
  inputValue: Signal<string>;
  stagedAttachments: Signal<StagedAttachment[]>;
  stagedWikiReferences: Signal<StagedWikiReference[]>;
  onSend: () => void;
  onStop: () => void;
  onFocus: () => void;
  onBlur: () => void;
  isGenerating: boolean;
  disabled: boolean;
  providers: ProviderInfo[];
  favoriteModels: FavoriteModel[];
  activeProvider?: string | null;
  activeModel?: string | null;
  onModelSelect: (provider: string, model: string) => void;
  threadId?: string;
  workspaceId: string;
  autoApproveShell?: boolean;
  onToggleAutoApproveShell: () => void;
}) {
  return (
    <ChatInput
      value={inputValue.value}
      onValueChange={(v) => {
        inputValue.value = v;
      }}
      onSend={onSend}
      onStop={onStop}
      onFocus={onFocus}
      onBlur={onBlur}
      isGenerating={isGenerating}
      disabled={disabled}
      providers={providers}
      favoriteModels={favoriteModels}
      activeProvider={activeProvider}
      activeModel={activeModel}
      onModelSelect={onModelSelect}
      threadId={threadId}
      workspaceId={workspaceId}
      autoApproveShell={autoApproveShell}
      onToggleAutoApproveShell={onToggleAutoApproveShell}
      attachments={stagedAttachments.value}
      onAttachmentsChange={(next) => {
        stagedAttachments.value = next;
      }}
      wikiReferences={stagedWikiReferences.value}
      onWikiReferencesChange={(next) => {
        stagedWikiReferences.value = next;
      }}
    />
  );
}

export function WorkspaceChatTab({
  workspace,
  onInputFocusChange,
}: {
  workspace: Workspace;
  // Mirrors the onGoToChat callback-prop pattern: the parent (WorkspaceDetailView)
  // hides mobile chrome while this fires true, and restores it on false. See
  // the workspace mobile detail redesign design, §7.
  onInputFocusChange?: (focused: boolean) => void;
}) {
  const inputValue = useSignal('');
  const stagedAttachments = useSignal<StagedAttachment[]>([]);
  const stagedWikiReferences = useSignal<StagedWikiReference[]>([]);
  // Declared alongside the signals above, ahead of the early `return null`
  // below, so this hook always runs in the same order every render.
  const stagedWikiReferenceKeys = useComputed(
    () => new Set(stagedWikiReferences.value.map((r) => `${r.wikiId}:${r.path}`)),
  );
  const forceScrollTrigger = useSignal(0);
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
    forceScrollTrigger.value++;
    inputValue.value = '';
    const attachments = stagedAttachments.value;
    stagedAttachments.value = [];
    const wikiReferences = stagedWikiReferences.value;
    stagedWikiReferences.value = [];
    thread.sendMessage(content, attachments, wikiReferences).catch(console.error);
  }

  function handleStageWikiReference(ref: StagedWikiReference) {
    const next = stageWikiReference(
      stagedWikiReferences.value,
      stagedAttachments.value.length,
      ref,
    );
    if (next) stagedWikiReferences.value = next;
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
        {thread.isWaitingForProvider.value && (
          <div class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            Waiting for {thread.waitingProviderName.value} to have capacity…
          </div>
        )}

        {thread.backgroundTurnActive.value && (
          <div
            data-testid="background-turn-status"
            class="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
          >
            The agent is working in the background…
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

        <ChatMessageScrollWrapper
          className="min-h-0 flex-1"
          forceScrollTrigger={forceScrollTrigger.value}
        >
          <div class="flex flex-col gap-4 p-4 pb-2">
            {scrollMessages.map((msg) => (
              // onFork intentionally omitted — a workspace has one rolling
              // thread for its whole lifetime, not a forkable tree of
              // conversations like the global chat's.
              <ThreadMessageItem
                key={msg.id}
                message={msg}
                threadId={workspace.threadId ?? undefined}
                onHitlAnswer={thread.submitHitlAnswer}
                onRetry={thread.retryTurn}
                onStageWikiReference={handleStageWikiReference}
                stagedWikiReferenceKeys={stagedWikiReferenceKeys.value}
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
            <div class="flex items-center gap-1">
              <ThreadReportButton threadId={workspace.threadId ?? ''} />
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy}
                onClick={() => void handleSummarizeClick()}
              >
                Summarise
              </Button>
            </div>
          </div>
          <ChatComposer
            inputValue={inputValue}
            stagedAttachments={stagedAttachments}
            stagedWikiReferences={stagedWikiReferences}
            onSend={handleSend}
            onStop={thread.stopGeneration}
            onFocus={() => onInputFocusChange?.(true)}
            onBlur={() => onInputFocusChange?.(false)}
            isGenerating={thread.isStreaming.value || thread.backgroundTurnActive.value}
            disabled={!!thread.pendingHitlId.value || isBusy}
            providers={providers.value}
            favoriteModels={favoriteModels.value}
            activeProvider={thread.activeThreadModel.value?.provider}
            activeModel={thread.activeThreadModel.value?.model}
            onModelSelect={thread.setThreadModel}
            threadId={workspace.threadId}
            workspaceId={workspace.id}
            autoApproveShell={workspace.autoApproveShell}
            onToggleAutoApproveShell={() =>
              void patchWorkspace(workspace.id, { autoApproveShell: !workspace.autoApproveShell })
            }
          />
        </div>
      </div>
    </div>
  );
}
