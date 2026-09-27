import { useEffect } from 'preact/hooks';
import { useSignal, type ReadonlySignal } from '@preact/signals';
import { previewCron, type CronPreview, type CronPreviewRequest } from '@/services/tasks-api';

export const CRON_PREVIEW_DEBOUNCE_MS = 300;

export type CronPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'valid'; preview: CronPreview }
  | { status: 'invalid'; error: string }
  | { status: 'error'; error: string };

// Asks the server to validate and read back a schedule, 300 ms after the
// last change. Only the latest request's answer is kept. `null` (nothing
// entered yet) resets to idle. Save should be allowed only on 'valid'.
export function useCronPreview(input: CronPreviewRequest | null): ReadonlySignal<CronPreviewState> {
  const state = useSignal<CronPreviewState>({ status: 'idle' });
  const key = input ? JSON.stringify(input) : '';

  useEffect(() => {
    if (!input) {
      state.value = { status: 'idle' };
      return;
    }
    state.value = { status: 'loading' };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCron(input, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) return;
          state.value = preview.valid
            ? { status: 'valid', preview }
            : { status: 'invalid', error: preview.error ?? 'Invalid schedule' };
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          state.value = {
            status: 'error',
            error: err instanceof Error ? err.message : 'Could not check the schedule.',
          };
        });
    }, CRON_PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `key` captures every field of `input`.
  }, [key]);

  return state;
}
