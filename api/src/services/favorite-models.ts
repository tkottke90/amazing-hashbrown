import type { FavoriteModel } from '../config/env.js';

interface LiveProvider {
  name: string;
  models: { id: string }[];
}

// Narrows the configured favorites to those the chat can actually select
// right now: the provider still exists and its live model list includes the
// model. Order is preserved. A provider that is unreachable reports no
// models, so its favorites drop out until it comes back — they are never
// removed from config (stale entries stay visible, badged, in Settings).
export function resolveAvailableFavorites(
  favorites: FavoriteModel[],
  providers: LiveProvider[],
): FavoriteModel[] {
  const liveModels = new Map(providers.map((p) => [p.name, new Set(p.models.map((m) => m.id))]));
  return favorites.filter((f) => liveModels.get(f.provider)?.has(f.model) ?? false);
}
