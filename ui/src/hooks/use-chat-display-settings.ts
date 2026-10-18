import { signal } from '@preact/signals';
import { fetchSettingsSection } from '@/services/settings-api';

interface ChatDisplaySettingsShape {
  chat?: { codeBlockWrap?: boolean };
}

export const codeBlockWrap = signal<boolean>(false);
const _lastFetchedAt = signal<number>(0);
const TTL_MS = 60_000;

export async function fetchChatDisplaySettings(): Promise<void> {
  if (Date.now() - _lastFetchedAt.value < TTL_MS) return;
  try {
    const result = await fetchSettingsSection<ChatDisplaySettingsShape>('agent-behavior');
    codeBlockWrap.value = result.chat?.codeBlockWrap ?? false;
    _lastFetchedAt.value = Date.now();
  } catch {
    // best-effort — mirrors fetchProviders()'s silent-catch pattern
  }
}

// Drops the TTL cache so the next fetchChatDisplaySettings() hits the API.
export function invalidateChatDisplaySettings(): void {
  _lastFetchedAt.value = 0;
}
