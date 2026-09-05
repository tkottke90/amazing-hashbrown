import { signal } from '@preact/signals';

const STORAGE_KEY = 'hashbrown-media-muted';

export const mediaMuted = signal<boolean>(localStorage.getItem(STORAGE_KEY) === 'true');

export function toggleMediaMuted(): void {
  mediaMuted.value = !mediaMuted.value;
  localStorage.setItem(STORAGE_KEY, String(mediaMuted.value));
}
