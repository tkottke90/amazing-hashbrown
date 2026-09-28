import { useSignal } from '@preact/signals';
import { MessageCircleQuestion } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BoardReason, Task } from '@/services/tasks-api';
import { performMove } from './board-move';

type WaitingReason = Extract<BoardReason, { kind: 'waiting_on_user' }>;

// Answers the question a waiting task's agent asked: one tap on a quick
// reply, or a typed answer. Sending moves the task back to the Queue (the
// server resumes the paused run with the answer). Shared by the desktop task
// drawer and the mobile reply sheet.
export function ReplyForm({
  task,
  reason,
  onSent,
}: {
  task: Task;
  reason: WaitingReason;
  onSent?: () => void;
}) {
  const text = useSignal('');
  const sending = useSignal(false);

  async function send(reply: string) {
    if (!reply.trim() || sending.value) return;
    sending.value = true;
    const moved = await performMove(
      task,
      { to: 'queue', reply },
      { successMessage: `Answered: ${task.title}` },
    );
    sending.value = false;
    if (moved) {
      text.value = '';
      onSent?.();
    }
  }

  return (
    <div class="flex flex-col gap-3" data-testid="board-reply-form">
      <div class="flex items-start gap-2">
        <MessageCircleQuestion class="mt-0.5 size-4 shrink-0 text-amber-600" />
        <p class="text-sm font-medium leading-snug" data-testid="board-reply-question">
          {reason.question ?? 'The agent is waiting for your answer.'}
        </p>
      </div>
      {reason.choices.length > 0 && (
        <div class="flex flex-wrap gap-2">
          {reason.choices.map((choice) => (
            <Button
              key={choice.value}
              type="button"
              size="sm"
              variant="outline"
              disabled={sending.value}
              data-testid="board-reply-choice"
              onClick={() => void send(choice.value)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      {reason.allowFreeText && (
        <form
          class="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text.value);
          }}
        >
          <Input
            aria-label="Your answer"
            placeholder="Type your answer…"
            value={text.value}
            onInput={(e) => {
              text.value = (e.target as HTMLInputElement).value;
            }}
          />
          <Button type="submit" size="sm" disabled={sending.value || !text.value.trim()}>
            {sending.value ? 'Sending…' : 'Send'}
          </Button>
        </form>
      )}
    </div>
  );
}
