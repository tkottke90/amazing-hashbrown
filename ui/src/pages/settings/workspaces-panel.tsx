import { useSignal } from '@preact/signals';
import { cn } from '@/lib/utils';
import { useTitle } from '@/hooks/use-title';
import { TrackersSection } from './trackers-section';

type WorkspacesSubsection = 'trackers';

const SUBSECTIONS: { label: string; slug: WorkspacesSubsection }[] = [
  { label: 'Trackers', slug: 'trackers' },
];

export function WorkspacesPanel() {
  useTitle('Settings - Workspaces');
  const activeSubsection = useSignal<WorkspacesSubsection>('trackers');

  return (
    <div class="flex min-h-full flex-col">
      <div class="border-b border-border px-6 pt-4">
        <div class="flex gap-1 pb-3">
          {SUBSECTIONS.map(({ label, slug }) => {
            const isActive = slug === activeSubsection.value;
            return (
              <button
                key={slug}
                type="button"
                data-slot="workspaces-subnav-item"
                data-active={isActive ? 'true' : 'false'}
                onClick={() => (activeSubsection.value = slug)}
                class={cn(
                  'rounded-full px-3 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div class="min-h-0 flex-1">
        {activeSubsection.value === 'trackers' && <TrackersSection />}
      </div>
    </div>
  );
}
