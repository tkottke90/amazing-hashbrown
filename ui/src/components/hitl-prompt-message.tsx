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

function approveVariant(
  t: 'primary' | 'secondary' | 'destructive' | undefined,
): 'default' | 'secondary' | 'destructive' {
  if (t === 'destructive') return 'destructive';
  if (t === 'secondary') return 'secondary';
  return 'default';
}

function parseChoice(raw: string): { label: string; description?: string } {
  const idx = raw.indexOf(' - ');
  if (idx < 0) return { label: raw };
  return { label: raw.slice(0, idx), description: raw.slice(idx + 3) };
}

export function HitlPromptMessage({ message, onAnswer, className }: HitlPromptMessageProps) {
  const freeTextValue = useSignal('');

  function submit(answer: string) {
    if (!answer.trim()) return;
    onAnswer(message.promptId, answer);
  }

  if (message.status === 'answered') {
    return (
      <div
        className={cn(
          'self-end rounded-lg bg-card px-3 py-4 shadow-md text-sm max-w-[min(80%,75ch)]',
          className,
        )}
      >
        <div className="mb-2 flex items-start gap-2">
          <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <strong className="leading-snug">{message.question}</strong>
        </div>
        <p>{message.answer}</p>
      </div>
    );
  }

  const isMultipleChoice = message.promptKind === 'multiple_choice';

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-card text-sm shadow-sm overflow-hidden',
        className,
      )}
    >
      {/* Question header */}
      <div className={cn('flex items-start gap-2 px-4 pt-4', isMultipleChoice ? 'pb-3' : 'pb-0')}>
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="font-medium leading-snug">{message.question}</p>
      </div>

      {/* Controls */}
      {message.promptKind === 'shell_approval' ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          {message.command && (
            <pre className="rounded bg-muted px-3 py-2 text-sm font-mono overflow-x-auto">
              <code>{message.command}</code>
            </pre>
          )}
          {message.reason && (
            <p className="text-sm text-muted-foreground">{message.reason}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => submit('denied')}>
              Deny
            </Button>
            <Button size="sm" variant="secondary" onClick={() => submit('approved_remember')}>
              Approve &amp; remember
            </Button>
            <Button size="sm" onClick={() => submit('approved')}>
              Approve
            </Button>
          </div>
        </div>
      ) : message.promptKind === 'yes_no' ? (
        <div className="flex justify-end gap-2 px-4 py-3">
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
        <div className="border-t border-border">
          {message.choices?.map((raw) => {
            const { label, description } = parseChoice(raw);
            return (
              <button
                key={raw}
                type="button"
                onClick={() => submit(raw)}
                className="flex w-full cursor-pointer items-baseline gap-1 px-4 py-2 text-left transition-colors hover:bg-accent"
              >
                <strong>{label}</strong>
                {description && (
                  <span className="text-muted-foreground">&nbsp;-&nbsp;{description}</span>
                )}
              </button>
            );
          })}
          {message.allowFreeText && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(freeTextValue.value);
              }}
              className="flex gap-2 border-t border-border px-4 py-2"
            >
              <Input
                value={freeTextValue.value}
                onInput={(e) => {
                  freeTextValue.value = (e.target as HTMLInputElement).value;
                }}
                placeholder="Custom answer…"
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
          className="flex gap-2 px-4 py-3"
        >
          <Input
            value={freeTextValue.value}
            onInput={(e) => {
              freeTextValue.value = (e.target as HTMLInputElement).value;
            }}
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
