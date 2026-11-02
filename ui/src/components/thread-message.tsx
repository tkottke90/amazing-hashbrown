import { ChatMessage, ChatMessageCopyAction, ChatMessageForkAction } from './chat-message';
import { AssistantMessage } from './assistant-message';
import { ToolCallMessage } from './tool-call-message';
import { HitlPromptMessage } from './hitl-prompt-message';
import { IframeMessage } from './iframe-message';
import { AudioMessage } from './audio-message';
import { WikiUpdateMessage } from './wiki-update-message';
import type { StagedWikiReference } from './chat-input';
import { ResourceCardMessage } from './resource-card-message';
import { TaskRunMarkerMessage } from './task-run-marker-message';
import { WakeupCard } from './wakeup-card';
import { WakeupFiredMarker } from './wakeup-fired-marker';
import type { ThreadMessage } from '../types/thread-message';

interface ThreadMessageItemProps {
  message: ThreadMessage;
  // The thread the message belongs to — lets interactive cards (wake-up
  // Cancel / Trigger now) act on it. Omitted by read-only views.
  threadId?: string;
  onHitlAnswer: (promptId: string, answer: string) => void;
  onRetry?: () => void;
  onFork?: (seq: number) => void;
  // Lets a Wiki Update Message card stage its own page into the active
  // composer — omitted by callers with no live composer (read-only thread
  // views), in which case the card's "Add to Message" button never renders.
  onStageWikiReference?: (ref: StagedWikiReference) => void;
  // Keyed `${wikiId}:${path}` — lets every Wiki Update Message card in the
  // thread independently compute whether its own page is already staged.
  stagedWikiReferenceKeys?: Set<string>;
}

export function ThreadMessageItem({
  message,
  threadId,
  onHitlAnswer,
  onRetry,
  onFork,
  onStageWikiReference,
  stagedWikiReferenceKeys,
}: ThreadMessageItemProps) {
  switch (message.kind) {
    case 'user':
      return (
        <ChatMessage
          message={message.content}
          sentAt={message.sentAt}
          mirrored
          showBG
          className="self-end"
          attachments={message.attachments}
          wikiReferences={message.wikiReferences}
          actions={
            <>
              <ChatMessageCopyAction content={message.content} />
              {message.seq !== undefined && onFork && (
                <ChatMessageForkAction onFork={() => onFork(message.seq!)} />
              )}
            </>
          }
        />
      );

    case 'assistant':
      return (
        <AssistantMessage
          message={message}
          onRetry={message.status === 'error' ? onRetry : undefined}
          onFork={
            message.status === 'done' && message.seq !== undefined && onFork
              ? () => onFork(message.seq!)
              : undefined
          }
        />
      );

    case 'tool_call':
      return <ToolCallMessage message={message} />;

    case 'hitl_prompt':
      return <HitlPromptMessage message={message} onAnswer={onHitlAnswer} />;

    case 'iframe':
      return <IframeMessage message={message} />;

    case 'audio':
      return <AudioMessage message={message} />;

    case 'wiki_update':
      return (
        <WikiUpdateMessage
          message={message}
          onStageWikiReference={onStageWikiReference}
          isStaged={stagedWikiReferenceKeys?.has(`${message.wikiName}:${message.path}`)}
        />
      );

    case 'resource_card':
      return <ResourceCardMessage message={message} />;

    case 'task_run_marker':
      return <TaskRunMarkerMessage message={message} />;

    case 'wakeup':
      return <WakeupCard message={message} threadId={threadId} />;

    case 'wakeup_fired':
      return <WakeupFiredMarker message={message} />;
  }
}
