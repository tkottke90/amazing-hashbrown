import { signal } from '@preact/signals';

interface SettingsGuard {
  isDirty: boolean;
  discard: () => void;
}

export const activeGuard = signal<SettingsGuard | null>(null);

/**
 * Checks the currently registered dirty settings section (if any) before a
 * navigation proceeds. Returns true if it's safe to navigate — either
 * nothing is dirty, or the user confirmed leaving anyway (in which case the
 * dirty panel's changes are discarded so it doesn't come back stale).
 */
export function confirmNavigateAway(): boolean {
  const guard = activeGuard.value;
  if (!guard?.isDirty) return true;
  if (!confirm('You have unsaved changes. Leave without saving?')) return false;
  guard.discard();
  return true;
}
