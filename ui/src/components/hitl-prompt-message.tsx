import { useSignal } from '@preact/signals';
import { MessageCircleQuestion } from 'lucide-preact';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ChatMessage } from './chat-message';
import type { HitlThreadMessage } from '../types/thread-message';

interface HitlPromptMessageProps {
  message: HitlThreadMessage;
  onAnswer: (promptId: string, answer: string) => void;
  className?: string;
}

function approveVariant(
  t: 'primary' | 'secondary' | 'destructive' | undefined,
): 'default' | 'secondary' | 'destructive' {
  if (t === 'destructive') return 'destructive';
  if (t === 'secondary') return 'secondary';
  return 'default';
}

export function HitlPromptMessage({ message, onAnswer, className }: HitlPromptMessageProps) {
  const freeTextValue = useSignal('');

  function submit(answer: string) {
    if (!answer.trim()) return;
    onAnswer(message.promptId, answer);
  }

  if (message.status === 'answered') {
    return (
      <>
        <div className={cn('rounded-md border border-border bg-card p-4 text-sm shadow-sm', className)}>
          <div className="flex items-start gap-2">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="font-medium leading-snug">{message.question}</p>
          </div>
        </div>
        <ChatMessage
          message={message.answer ?? ''}
          sentAt={new Date()}
          mirrored
          showBG
          className="self-end"
        />
      </>
    );
  }

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-card p-4 text-sm shadow-sm',
        className,
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="font-medium leading-snug">{message.question}</p>
      </div>

      {message.promptKind === 'yes_no' ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => submit(message.rejectLabel ?? 'No')}>
            {message.rejectLabel ?? 'No'}
          </Button>
          <Button
            size="sm"
            variant={approveVariant(message.approveType)}
            onClick={() => submit(message.approveLabel ?? 'Yes')}
          >
            {message.approveLabel ?? 'Yes'}
          </Button>
        </div>
      ) : message.promptKind === 'multiple_choice' ? (
        <div>
          <div className="flex flex-wrap gap-2">
            {message.choices?.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => submit(choice)}
                className={cn(
                  'cursor-pointer rounded-lg border border-border bg-background px-4 py-2 text-left text-sm',
                  'transition-all duration-150',
                  'hover:border-primary/50 hover:bg-accent hover:shadow-sm',
                )}
              >
                <strong>{choice}</strong>
              </button>
            ))}
          </div>
          {message.allowFreeText && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(freeTextValue.value);
              }}
              className="mt-3 flex gap-2"
            >
              <Input
                value={freeTextValue.value}
                onInput={(e) => { freeTextValue.value = (e.target as HTMLInputElement).value; }}
                placeholder="Or type a custom answer…"
                className="h-8 text-sm"
              />
              <Button type="submit" size="sm" disabled={!freeTextValue.value.trim()}>
                Submit
              </Button>
            </form>
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(freeTextValue.value);
          }}
          className="flex gap-2"
        >
          <Input
            value={freeTextValue.value}
            onInput={(e) => { freeTextValue.value = (e.target as HTMLInputElement).value; }}
            placeholder="Type your answer…"
            className="h-8 text-sm"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!freeTextValue.value.trim()}>
            Submit
          </Button>
        </form>
      )}
    </div>
  );
}
