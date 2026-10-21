import { FileDown } from 'lucide-preact';

interface WorkspaceRetrospectiveButtonProps {
  workspaceId: string;
  variant?: 'outline' | 'action-row';
}

export function WorkspaceRetrospectiveButton({
  workspaceId,
  variant = 'outline',
}: WorkspaceRetrospectiveButtonProps) {
  const open = () =>
    window.open(`/api/v1/workspaces/${workspaceId}/retrospective-report`, '_blank');

  if (variant === 'action-row') {
    return (
      <button
        type="button"
        data-testid="actions-retrospective-report"
        class="rounded-md border border-border px-3 py-1.5 text-sm"
        onClick={open}
      >
        Generate
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Generate retrospective report"
      aria-label="Generate retrospective report"
      class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-sidebar-accent transition-colors"
    >
      <FileDown class="size-3.5" />
      Retrospective
    </button>
  );
}
