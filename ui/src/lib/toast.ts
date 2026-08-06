import { signal } from '@preact/signals';

export interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
}

export const toasts = signal<Toast[]>([]);

let _nextId = 0;

export function showToast(type: 'success' | 'error', message: string, durationMs = 4000): void {
  const id = String(_nextId++);
  toasts.value = [...toasts.value, { id, type, message }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, durationMs);
}
