import { useEffect } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { fetchSettingsSection, patchSettingsSection, SettingsValidationError } from '@/services/settings-api';
import { showToast } from '@/lib/toast';

function setNestedPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (cursor[key] === null || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function useSettingsSection<T extends object>(slug: string) {
  const data = useSignal<T | null>(null);
  const form = useSignal<T | null>(null);
  const isSaving = useSignal(false);
  const fetchError = useSignal<string | null>(null);
  const fieldErrors = useSignal<Record<string, string[]>>({});

  const isDirty = useComputed(
    () => JSON.stringify(data.value) !== JSON.stringify(form.value),
  );

  useEffect(() => {
    let cancelled = false;
    fetchError.value = null;
    fetchSettingsSection<T>(slug)
      .then((result) => {
        if (cancelled) return;
        data.value = result;
        form.value = structuredClone(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        fetchError.value = err instanceof Error ? err.message : 'Failed to load settings';
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function setField(dotPath: string, value: unknown) {
    if (!form.value) return;
    const clone = structuredClone(form.value) as Record<string, unknown>;
    setNestedPath(clone, dotPath, value);
    form.value = clone as T;
    fieldErrors.value = {};
  }

  async function save() {
    if (!form.value) return;
    isSaving.value = true;
    try {
      const result = await patchSettingsSection<T>(slug, form.value);
      data.value = result;
      form.value = structuredClone(result);
      fieldErrors.value = {};
      showToast('success', 'Settings saved');
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        const fe =
          typeof err.fieldErrors === 'object' && err.fieldErrors !== null
            ? (err.fieldErrors as Record<string, string[]>)
            : {};
        fieldErrors.value = fe;
        showToast('error', 'Please fix the errors below');
      } else {
        showToast('error', err instanceof Error ? err.message : 'Failed to save settings');
      }
    } finally {
      isSaving.value = false;
    }
  }

  function discard() {
    form.value = structuredClone(data.value);
    fieldErrors.value = {};
  }

  return { data, form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard };
}
