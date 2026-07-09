import { useSignal } from '@preact/signals';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-preact';
import { cn } from '@/lib/utils';
import type { ToolCallThreadMessage } from '../types/thread-message';

interface ToolCallMessageProps {
  message: ToolCallThreadMessage;
  className?: string;
}

export function ToolCallMessage({ message, className }: ToolCallMessageProps) {
  const isOpen = useSignal(false);
  const isPending = message.status === 'pending';

  return (
    <div className={cn('rounded-md border border-border bg-muted/20 text-sm max-w-[min(80%,75ch)]', className)}>
      <button
        type="button"
        onClick={() => { isOpen.value = !isOpen.value; }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        {isOpen.value ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="font-mono text-xs font-semibold">{message.toolName}</code>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 text-xs font-medium',
            isPending
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
              : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
          )}
        >
          {isPending ? 'running' : 'done'}
        </span>
      </button>

      {isOpen.value && (
        <div className="border-t border-border divide-y divide-border">
          <div className="px-3 py-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Inputs</p>
            <pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(message.inputs, null, 2)}
            </pre>
          </div>

          {message.outputs !== undefined && (
            <div className="px-3 py-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</p>
              <pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-all">
                {typeof message.outputs === 'string'
                  ? message.outputs
                  : JSON.stringify(message.outputs, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
