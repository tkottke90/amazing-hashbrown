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
export const defaultProviderName = signal<string>('');
const _lastFetchedAt = signal<number>(0);
const TTL_MS = 60_000;

export async function fetchProviders(): Promise<void> {
  if (Date.now() - _lastFetchedAt.value < TTL_MS) return;
  try {
    const res = await fetch('/api/v1/providers');
    if (!res.ok) return;
    const data = (await res.json()) as { providers: ProviderInfo[]; defaultProvider?: string };
    providers.value = data.providers;
    defaultProviderName.value = data.defaultProvider ?? '';
    _lastFetchedAt.value = Date.now();
  } catch {
    // best-effort
  }
}

// Mirrors createProvider()'s own fallback chain (api/src/services/provider-factory.ts)
// — preferred name, else the first configured provider — so the chip's
// displayed default agrees with what the backend will actually resolve to.
export function pickDefaultModelSelection(
  list: ProviderInfo[],
  preferredName: string,
): { provider: string; model: string } | null {
  if (list.length === 0) return null;
  const target = (preferredName && list.find((p) => p.name === preferredName)) || list[0]!;
  const modelId = target.defaultModel ?? target.models[0]?.id;
  return modelId ? { provider: target.name, model: modelId } : null;
}
