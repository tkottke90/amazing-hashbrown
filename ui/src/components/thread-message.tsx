import { ChatMessage, ChatMessageCopyAction } from './chat-message';
import { AssistantMessage } from './assistant-message';
import { ToolCallMessage } from './tool-call-message';
import { HitlPromptMessage } from './hitl-prompt-message';
import { IframeMessage } from './iframe-message';
import { AudioMessage } from './audio-message';
import type { ThreadMessage } from '../types/thread-message';

interface ThreadMessageItemProps {
  message: ThreadMessage;
  onHitlAnswer: (promptId: string, answer: string) => void;
}

export function ThreadMessageItem({ message, onHitlAnswer }: ThreadMessageItemProps) {
  switch (message.kind) {
    case 'user':
      return (
        <ChatMessage
          message={message.content}
          sentAt={message.sentAt}
          mirrored
          showBG
          className="self-end"
          actions={<ChatMessageCopyAction content={message.content} />}
        />
      );

    case 'assistant':
      return <AssistantMessage message={message} />;

    case 'tool_call':
      return <ToolCallMessage message={message} />;

    case 'hitl_prompt':
      return <HitlPromptMessage message={message} onAnswer={onHitlAnswer} />;

    case 'iframe':
      return <IframeMessage message={message} />;

    case 'audio':
      return <AudioMessage message={message} />;
  }
}
