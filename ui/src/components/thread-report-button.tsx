import { Download, FileDown } from 'lucide-preact';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

interface ThreadReportButtonProps {
  threadId: string;
  variant?: 'icon' | 'menu-item';
}

export function ThreadReportButton({ threadId, variant = 'icon' }: ThreadReportButtonProps) {
  const open = () => window.open(`/api/v1/threads/${threadId}/report`, '_blank');

  if (variant === 'menu-item') {
    return (
      <DropdownMenuItem onSelect={open}>
        <FileDown class="size-4" />
        Generate thread report
      </DropdownMenuItem>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Generate thread report"
      class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
    >
      <Download class="size-3.5" />
    </button>
  );
}
