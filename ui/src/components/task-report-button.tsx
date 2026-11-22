import { Download, FileDown } from 'lucide-preact';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

interface TaskReportButtonProps {
  taskId: string;
  variant?: 'icon' | 'menu-item' | 'outline';
}

export function TaskReportButton({ taskId, variant = 'icon' }: TaskReportButtonProps) {
  const open = () => window.open(`/api/v1/tasks/${taskId}/report`, '_blank');

  if (variant === 'menu-item') {
    return (
      <DropdownMenuItem onSelect={open}>
        <FileDown class="size-4" />
        Task report
      </DropdownMenuItem>
    );
  }

  if (variant === 'outline') {
    return (
      <Button type="button" variant="outline" onClick={open}>
        Task Report
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Generate task report"
      class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
    >
      <Download class="size-3.5" />
    </button>
  );
}
