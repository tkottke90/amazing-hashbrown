import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { fetchWidgets, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';

export function useDashboardWidgets() {
  const widgets = useSignal<WidgetLoadResult[]>([]);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);

  async function refresh() {
    try {
      widgets.value = await fetchWidgets(DEFAULT_DASHBOARD_ID);
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load dashboard widgets';
    } finally {
      loading.value = false;
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return { widgets, loading, error, refresh };
}
