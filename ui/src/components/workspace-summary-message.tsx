import { useSignal } from '@preact/signals';
import { FileText, ExternalLink, ChevronDown, ChevronRight } from 'lucide-preact';
import type { WorkspaceSummaryThreadMessage } from '../types/thread-message.js';
import { Markdown } from './markdown';

interface WorkspaceSummaryMessageProps {
  message: WorkspaceSummaryThreadMessage;
}

export function WorkspaceSummaryMessage({ message }: WorkspaceSummaryMessageProps) {
  const isOpen = useSignal(false);

  return (
    <div
      data-testid="workspace-summary-marker"
      className="flex flex-col items-center gap-1 py-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        data-testid="workspace-summary-toggle"
        onClick={() => {
          isOpen.value = !isOpen.value;
        }}
        aria-label={isOpen.value ? 'Collapse summary' : 'Expand summary'}
        className="flex items-center gap-2 opacity-70 transition-opacity hover:opacity-100"
      >
        <FileText className="size-3.5 shrink-0" />
        <span>Earlier messages were summarised</span>
        {isOpen.value ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
      </button>

      {isOpen.value && (
        <div
          data-testid="workspace-summary-content"
          className="flex w-full max-w-[min(80%,75ch)] flex-col gap-2 rounded-lg border border-border bg-muted/50 p-3 text-left text-foreground"
        >
          <Markdown>{message.content}</Markdown>
          <a
            href={`/api/v1/workspaces/${message.workspaceId}/files/${message.summaryPath}/content`}
            target="_blank"
            rel="noreferrer"
            data-testid="workspace-summary-raw-link"
            className="flex w-fit items-center gap-1 self-start text-primary hover:underline"
          >
            View raw file
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}
