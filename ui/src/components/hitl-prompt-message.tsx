import { useSignal } from '@preact/signals';
import { MessageCircleQuestion } from 'lucide-preact';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { HitlThreadMessage } from '../types/thread-message';

interface HitlPromptMessageProps {
  message: HitlThreadMessage;
  onAnswer: (promptId: string, answer: string) => void;
  className?: string;
}

export function HitlPromptMessage({ message, onAnswer, className }: HitlPromptMessageProps) {
  const freeTextValue = useSignal('');
  const isAnswered = message.status === 'answered';

  function submit(answer: string) {
    if (!answer.trim()) return;
    onAnswer(message.promptId, answer);
  }

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-card p-4 text-sm max-w-[min(80%,75ch)] shadow-sm',
        className,
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="font-medium leading-snug">{message.question}</p>
      </div>

      {isAnswered ? (
        <p className="text-muted-foreground text-xs">
          You answered: <span className="font-medium text-foreground">{message.answer}</span>
        </p>
      ) : message.promptKind === 'yes_no' ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => submit('yes')}>Yes</Button>
          <Button size="sm" variant="outline" onClick={() => submit('no')}>No</Button>
        </div>
      ) : message.promptKind === 'multiple_choice' ? (
        <div className="flex flex-wrap gap-2">
          {message.choices?.map((choice) => (
            <Button key={choice} size="sm" variant="outline" onClick={() => submit(choice)}>
              {choice}
            </Button>
          ))}
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
