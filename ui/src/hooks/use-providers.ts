import { signal } from '@preact/signals';

export interface ModelInfo {
  id: string;
  inputPricePerM?: number;
  outputPricePerM?: number;
}

export interface ProviderInfo {
  name: string;
  type: string;
  defaultModel?: string;
  models: ModelInfo[];
}

export const providers = signal<ProviderInfo[]>([]);
const _lastFetchedAt = signal<number>(0);
const TTL_MS = 60_000;

export async function fetchProviders(): Promise<void> {
  if (Date.now() - _lastFetchedAt.value < TTL_MS) return;
  try {
    const res = await fetch('/api/v1/providers');
    if (!res.ok) return;
    const data = (await res.json()) as { providers: ProviderInfo[] };
    providers.value = data.providers;
    _lastFetchedAt.value = Date.now();
  } catch {
    // best-effort
  }
}
