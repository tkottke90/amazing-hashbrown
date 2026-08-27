import { ChatMessage, ChatMessageCopyAction, ChatMessageForkAction } from './chat-message';
import { AssistantMessage } from './assistant-message';
import { ToolCallMessage } from './tool-call-message';
import { HitlPromptMessage } from './hitl-prompt-message';
import { IframeMessage } from './iframe-message';
import { AudioMessage } from './audio-message';
import { WikiUpdateMessage } from './wiki-update-message';
import { ResourceCardMessage } from './resource-card-message';
import type { ThreadMessage } from '../types/thread-message';

interface ThreadMessageItemProps {
  message: ThreadMessage;
  onHitlAnswer: (promptId: string, answer: string) => void;
  onRetry?: () => void;
  onFork?: (seq: number) => void;
}

export function ThreadMessageItem({
  message,
  onHitlAnswer,
  onRetry,
  onFork,
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
      return <WikiUpdateMessage message={message} />;

    case 'resource_card':
      return <ResourceCardMessage message={message} />;
  }
}
