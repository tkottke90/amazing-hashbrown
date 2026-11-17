import { Activity } from 'lucide-preact';
import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { TaskQueueMonitor } from './task-queue-monitor';
import { ProviderActivityMonitor } from './provider-activity-monitor';

// path prop is consumed by preact-iso's Router for route matching
export function MonitoringView(_props: { path?: string }) {
  useTitle('Monitoring');

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-6 pb-4">
          <div class="flex items-center gap-2 mb-6">
            <Activity class="size-5 text-muted-foreground" />
            <div>
              <h1 class="text-xl font-semibold">Monitoring</h1>
              <p class="text-sm text-muted-foreground mt-0.5">
                Every queued task app-wide, and who's using each provider's capacity right now
              </p>
            </div>
          </div>

          <TaskQueueMonitor />
          <ProviderActivityMonitor />
        </div>
      </div>
    </Layout>
  );
}
