import { useSignal } from '@preact/signals';
import { Plus, X } from 'lucide-preact';
import { sendWikiMessage } from '@/hooks/use-wiki-ingestion';

export function NewDomainForm() {
  const open = useSignal(false);
  const domainId = useSignal('');
  const description = useSignal('');
  const routingNotes = useSignal('');

  function handleSubmit(e: Event) {
    e.preventDefault();
    const id = domainId.value.trim();
    const desc = description.value.trim();
    if (!id || !desc) return;

    const notes = routingNotes.value.trim();
    const msg = [
      `Create a new wiki domain. ID: "${id}". Description: "${desc}".`,
      notes ? ` Routing notes: "${notes}".` : '',
    ].join('');

    void sendWikiMessage(msg);

    // Reset
    domainId.value = '';
    description.value = '';
    routingNotes.value = '';
    open.value = false;
  }

  if (!open.value) {
    return (
      <button
        type="button"
        onClick={() => (open.value = true)}
        class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
        title="New domain"
      >
        <Plus class="size-3" />
        New domain
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      class="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-xs shadow-sm"
    >
      <div class="flex items-center justify-between">
        <span class="font-medium text-foreground">New Domain</span>
        <button
          type="button"
          onClick={() => (open.value = false)}
          class="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <input
        type="text"
        placeholder="Domain ID (e.g. health-fitness)"
        value={domainId.value}
        onInput={(e) => (domainId.value = (e.target as HTMLInputElement).value)}
        class="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        required
      />

      <input
        type="text"
        placeholder="Description"
        value={description.value}
        onInput={(e) => (description.value = (e.target as HTMLInputElement).value)}
        class="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        required
      />

      <textarea
        placeholder="Routing notes (optional)"
        value={routingNotes.value}
        onInput={(e) => (routingNotes.value = (e.target as HTMLTextAreaElement).value)}
        rows={2}
        class="resize-none rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => (open.value = false)}
          class="rounded px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded bg-primary px-2 py-1 text-primary-foreground hover:bg-primary/90"
        >
          Create
        </button>
      </div>
    </form>
  );
}
