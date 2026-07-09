import { useSignal } from '@preact/signals';
import { Brain, ChevronDown, ChevronRight } from 'lucide-preact';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';

interface ThoughtBlockProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

export function ThoughtBlock({ content, isStreaming = false, className }: ThoughtBlockProps) {
  const isOpen = useSignal(false);

  return (
    <div className={cn('rounded-md border border-border bg-muted/40', className)}>
      <button
        type="button"
        onClick={() => { isOpen.value = !isOpen.value; }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {isOpen.value ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <Brain className="size-3.5 shrink-0" />
        <span className="font-medium">
          {isStreaming ? 'Thinking…' : 'Thought process'}
        </span>
        {isStreaming && (
          <span className="ml-1 inline-flex gap-0.5">
            <span className="animate-bounce size-1 rounded-full bg-muted-foreground [animation-delay:0ms]" />
            <span className="animate-bounce size-1 rounded-full bg-muted-foreground [animation-delay:150ms]" />
            <span className="animate-bounce size-1 rounded-full bg-muted-foreground [animation-delay:300ms]" />
          </span>
        )}
      </button>
      {isOpen.value && content && (
        <div className="border-t border-border px-3 py-2">
          <Markdown className="prose-sm text-muted-foreground">{content}</Markdown>
        </div>
      )}
    </div>
  );
}
