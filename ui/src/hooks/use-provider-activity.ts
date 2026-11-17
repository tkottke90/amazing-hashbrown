import { signal } from '@preact/signals';
import type { ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import { request } from '@/utils/fetch.utils';

// Live, in-memory view of ProviderQueue's per-provider concurrency gate (see
// GLOSSARY.md § Monitoring — Provider Activity Monitor). Kept live by the
// `provider_activity_update` broadcast (use-live-events.ts); fetchProviderActivity
// is the REST fallback used on first load and on SSE reconnect, mirroring
// queueState/fetchQueue in use-tasks.ts.
export const providerActivityState = signal<ProviderActivitySnapshot[]>([]);

export async function fetchProviderActivity(): Promise<void> {
  try {
    providerActivityState.value = await request<ProviderActivitySnapshot[]>(
      '/api/v1/provider-activity',
    );
  } catch {
    // best-effort — stays stale until the next successful refresh
  }
}
