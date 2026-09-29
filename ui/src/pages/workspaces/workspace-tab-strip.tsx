import type { Signal } from '@preact/signals';
import { useComputed } from '@preact/signals';

import { tasks } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';

export type DetailTab = 'overview' | 'tasks' | 'files' | 'chat';

export const DETAIL_TAB_TITLE_SUFFIX: Record<DetailTab, string> = {
  overview: '',
  tasks: ' - Kanban',
  files: ' - Files',
  chat: ' - Chat',
};

const TABS: DetailTab[] = ['overview', 'tasks', 'files', 'chat'];

// Segmented tab control for the mobile workspace detail view, docked above
// the bottom app bar (Layout's navStart) in place of the desktop underlined
// tab row. See the workspace mobile detail redesign design, §5.
export function WorkspaceTabStrip({
  tab,
  workspaceId,
}: {
  tab: Signal<DetailTab>;
  workspaceId: string;
}) {
  const hasAttention = useComputed(() =>
    tasks.value.some((t) => t.workspaceId === workspaceId && t.board?.lane === 'attention'),
  );

  return (
    <div
      data-testid="workspace-tab-strip"
      role="tablist"
      class="flex items-center gap-1 overflow-x-auto"
    >
      {TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab.value === t}
          onClick={() => {
            tab.value = t;
          }}
          class={cn(
            'relative shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
            tab.value === t
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t}
          {t === 'tasks' && hasAttention.value && (
            <span
              data-testid="tab-strip-attention-dot"
              class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500"
            />
          )}
        </button>
      ))}
    </div>
  );
}
