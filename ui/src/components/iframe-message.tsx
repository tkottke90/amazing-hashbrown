import { useSignal } from '@preact/signals';
import { ChevronDown, ChevronRight, Code } from 'lucide-preact';
import { cn } from '@/lib/utils';
import type { IframeThreadMessage } from '../types/thread-message';

interface IframeMessageProps {
  message: IframeThreadMessage;
  className?: string;
}

export function IframeMessage({ message, className }: IframeMessageProps) {
  const isOpen = useSignal(true);

  return (
    <div className={cn('rounded-md border border-border bg-card max-w-[min(80%,75ch)]', className)}>
      <button
        type="button"
        onClick={() => { isOpen.value = !isOpen.value; }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/30 transition-colors"
      >
        {isOpen.value ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Code className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">Rendered output</span>
      </button>

      {isOpen.value && (
        <div className="border-t border-border">
          <iframe
            srcDoc={message.html}
            sandbox="allow-scripts"
            className="w-full rounded-b-md"
            style={{ minHeight: '200px', border: 'none' }}
            title="Rendered content"
          />
        </div>
      )}
    </div>
  );
}
