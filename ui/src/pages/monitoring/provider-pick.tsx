import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buttonVariants } from '@/components/ui/button';
import { useProviderModelPicker } from '@/components/provider-model-picker';
import { providers } from '@/hooks/use-providers';
import { patchTask } from '@/hooks/use-tasks';
import { showToast } from '@/lib/toast';
import type { Task } from '@/services/tasks-api';
import { cn } from '@/lib/utils';

// The Pinned Provider switch (GLOSSARY.md § Monitoring) — reuses the exact
// provider/model PATCH task-drawer.tsx's own picker uses, immediately
// (no form/Save step), and the server's own already-enforced restriction:
// a running Task rejects the change, so this is locked/inert for one
// instead of letting the PATCH round-trip fail every time.
export function ProviderPickButton({ task }: { task: Task }) {
  const locked = task.status === 'running';

  const { items, sheet } = useProviderModelPicker({
    providers: providers.value,
    activeProvider: task.provider ?? undefined,
    activeModel: task.model ?? undefined,
    onSelect: (provider, model) => {
      patchTask(task.id, { provider, model }).catch((err: unknown) => {
        showToast('error', err instanceof Error ? err.message : 'Could not switch provider.');
      });
    },
  });

  const label = task.provider && task.model ? `${task.provider} · ${task.model}` : 'System default';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={locked}
          title={
            locked
              ? "Can't switch provider while running — pause or cancel instead."
              : 'Switch provider — takes effect immediately.'
          }
          className={cn(
            buttonVariants({ variant: 'outline', size: 'xs' }),
            'font-mono text-xs justify-start max-w-56 truncate',
          )}
        >
          {label}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{items}</DropdownMenuContent>
      </DropdownMenu>
      {sheet}
    </>
  );
}
