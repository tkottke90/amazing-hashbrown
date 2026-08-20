import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { TrackerConfigModal } from './tracker-config-modal';
import { listTrackers, type Tracker } from '@/services/trackers-api';

type TrackersSettings = Record<string, Record<string, string | undefined> | undefined>;

export function TrackersSection() {
  const { form, isDirty, isSaving, fetchError, setField, save, discard } =
    useSettingsSection<TrackersSettings>('trackers');

  const trackers = useSignal<Tracker[]>([]);
  const trackersError = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTrackers()
      .then((result) => {
        if (!cancelled) trackers.value = result;
      })
      .catch((err: unknown) => {
        if (!cancelled) trackersError.value = err instanceof Error ? err.message : 'Failed to load trackers';
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (trackersError.value) {
    return <div class="p-6 text-sm text-destructive">{trackersError.value}</div>;
  }

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  function handleSave(type: string, values: Record<string, string | undefined>) {
    setField(type, values);
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Trackers</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="mb-3 text-xs text-muted-foreground">
              Registered tracker adapters available for linking tasks to external issues. This list
              reflects what's actually running on the server, not just what's configured.
            </p>
            {trackers.value.length === 0 ? (
              <p class="py-4 text-center text-sm text-muted-foreground">No trackers registered.</p>
            ) : (
              <ul class="divide-y divide-border">
                {trackers.value.map((tracker) => (
                  <li
                    key={tracker.type}
                    data-slot="tracker-row"
                    class="flex items-center justify-between gap-3 py-3"
                  >
                    <div class="flex min-w-0 items-center gap-2">
                      <span
                        class="flex size-[18px] shrink-0 items-center"
                        dangerouslySetInnerHTML={{ __html: tracker.icon }}
                      />
                      <span class="font-medium text-sm">{tracker.displayName}</span>
                      {tracker.canCreate ? (
                        <span class="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                          Link &amp; create
                        </span>
                      ) : (
                        <span class="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                          Link only
                        </span>
                      )}
                    </div>
                    {tracker.authSchema.length > 0 && (
                      <TrackerConfigModal
                        tracker={tracker}
                        initial={form.value?.[tracker.type]}
                        onSave={(values) => handleSave(tracker.type, values)}
                        trigger={
                          <Button type="button" variant="ghost" size="sm">
                            Configure
                          </Button>
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <SaveDiscardBar isDirty={isDirty.value} isSaving={isSaving.value} onSave={save} onDiscard={discard} />
    </div>
  );
}
