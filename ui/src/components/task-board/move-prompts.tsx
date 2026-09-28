import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Modal } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { CronOnceFields } from '@/components/cron-once-fields';
import { onceConfigFrom, onceDraftFrom, toLocalDateTimeInput } from '@/lib/cron-drafts';
import type { Task } from '@/services/tasks-api';
import { LANE_LABELS, movePrompt, performMove, type MovePrompt } from './board-move';

// Tomorrow at 09:00 local — the picker's starting value when a task has no
// start time yet.
function defaultStartTime(): string {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return toLocalDateTimeInput(at.toISOString());
}

function StartTimeForm({ task, to }: { task: Task; to: MovePrompt['to'] }) {
  const existing = task.triggerType === 'cron_once' ? task.triggerConfig : null;
  const initial = onceDraftFrom(existing);
  const draft = useSignal(initial.fireAt ? initial : { ...initial, fireAt: defaultStartTime() });
  const saving = useSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    const { fireAt, timezone } = onceConfigFrom(draft.value);
    saving.value = true;
    const moved = await performMove(task, { to, startAt: fireAt, timezone });
    saving.value = false;
    if (moved) movePrompt.value = null;
  }

  return (
    <form onSubmit={submit} class="flex flex-col gap-4" data-testid="move-start-time-form">
      <p class="text-sm text-muted-foreground">
        <span class="font-medium text-foreground">{task.title}</span> joins the Queue at this time.
      </p>
      <CronOnceFields draft={draft} />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => (movePrompt.value = null)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving.value || !draft.value.fireAt}>
          {saving.value ? 'Scheduling…' : 'Schedule'}
        </Button>
      </div>
    </form>
  );
}

function ReassignForm({
  task,
  to,
  position,
}: {
  task: Task;
  to: MovePrompt['to'];
  position?: number;
}) {
  const saving = useSignal(false);

  async function confirm() {
    saving.value = true;
    const moved = await performMove(task, { to, position, assignTo: 'agent' });
    saving.value = false;
    if (moved) movePrompt.value = null;
  }

  return (
    <div class="flex flex-col gap-4" data-testid="move-reassign-confirm">
      <p class="text-sm text-muted-foreground">
        <span class="font-medium text-foreground">{task.title}</span> is assigned to you. Moving it
        to {LANE_LABELS[to]} hands it to the agent, which will run it when its turn comes.
      </p>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => (movePrompt.value = null)}>
          Keep it
        </Button>
        <Button type="button" size="sm" disabled={saving.value} onClick={() => void confirm()}>
          {saving.value ? 'Handing off…' : 'Hand to agent'}
        </Button>
      </div>
    </div>
  );
}

// The dialogs a Kanban move opens when it needs input first: a start time
// (moving to Scheduled) or confirmation that a task assigned to you should
// go to the agent. Driven by the global `movePrompt` signal and mounted once
// at the app root, so the board, the mobile list and the task drawer all
// share it.
export function MovePrompts() {
  const prompt = movePrompt.value;
  const startOpen = useSignal(false);
  const reassignOpen = useSignal(false);

  useEffect(() => {
    startOpen.value = prompt?.kind === 'start_time';
    reassignOpen.value = prompt?.kind === 'reassign';
  }, [prompt]);

  const dismiss = () => {
    movePrompt.value = null;
  };

  return (
    <>
      <Modal title="Schedule task" open={startOpen} onClose={dismiss} onCancel={dismiss}>
        {prompt?.kind === 'start_time' && (
          <StartTimeForm key={prompt.task.id} task={prompt.task} to={prompt.to} />
        )}
      </Modal>
      <Modal title="Hand to the agent?" open={reassignOpen} onClose={dismiss} onCancel={dismiss}>
        {prompt?.kind === 'reassign' && (
          <ReassignForm
            key={prompt.task.id}
            task={prompt.task}
            to={prompt.to}
            position={prompt.position}
          />
        )}
      </Modal>
    </>
  );
}
