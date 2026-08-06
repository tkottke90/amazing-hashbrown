import { toasts } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function ToastContainer() {
  const items = toasts.value;
  if (items.length === 0) return null;

  return (
    <div class="fixed right-4 top-4 z-50 flex flex-col gap-2">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          class={cn(
            'rounded-md border px-4 py-3 text-sm shadow-md',
            toast.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
          )}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
