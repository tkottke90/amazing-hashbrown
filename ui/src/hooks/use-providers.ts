import { signal } from '@preact/signals';

export interface ModelInfo {
  id: string;
  // Whether this model accepts image input — resolved server-side (see
  // resolveVisionCapability in api/src/services/provider-factory.ts).
  // Absent/false is treated the same: the conservative "unsupported"
  // default when nothing is known about the model.
  imageInput?: boolean;
  inputPricePerM?: number;
  outputPricePerM?: number;
}

export interface ProviderInfo {
  name: string;
  type: string;
  defaultModel?: string;
  models: ModelInfo[];
}

// A user-pinned provider/model pair (config.yaml `favoriteModels`). The
// /api/v1/providers response only includes favorites that resolve against
// the live model lists, so every entry here is selectable.
export interface FavoriteModel {
  provider: string;
  model: string;
}

export const providers = signal<ProviderInfo[]>([]);
export const defaultProviderName = signal<string>('');
export const favoriteModels = signal<FavoriteModel[]>([]);
const _lastFetchedAt = signal<number>(0);
const TTL_MS = 60_000;

export async function fetchProviders(): Promise<void> {
  if (Date.now() - _lastFetchedAt.value < TTL_MS) return;
  try {
    const res = await fetch('/api/v1/providers');
    if (!res.ok) return;
    const data = (await res.json()) as {
      providers: ProviderInfo[];
      defaultProvider?: string;
      favoriteModels?: FavoriteModel[];
    };
    providers.value = data.providers;
    defaultProviderName.value = data.defaultProvider ?? '';
    favoriteModels.value = data.favoriteModels ?? [];
    _lastFetchedAt.value = Date.now();
  } catch {
    // best-effort
  }
}

// Drops the TTL cache so the next fetchProviders() hits the API — call after
// saving provider settings so the chat menu reflects the change immediately.
export function invalidateProviders(): void {
  _lastFetchedAt.value = 0;
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
