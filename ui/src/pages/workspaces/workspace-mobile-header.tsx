import { ArrowLeft, GitBranch, BookOpen, Calendar } from 'lucide-preact';

import { getProjectForWorkspace } from '@/hooks/use-workspaces';
import { cn } from '@/lib/utils';
import type { Workspace } from '@/services/workspaces-api';

// The compact (~52px) mobile header: a back arrow replaces the breadcrumb,
// and the icon cluster is a single shared trigger for the Details sheet
// rather than per-icon taps. See the workspace mobile detail redesign
// design, §2.
export function WorkspaceMobileHeader({
  workspace,
  proj,
  isActive,
  isTerminal,
  onOpenDetails,
  route,
}: {
  workspace: Workspace;
  proj: ReturnType<typeof getProjectForWorkspace>;
  isActive: boolean;
  isTerminal: boolean;
  onOpenDetails: () => void;
  route: (path: string) => void;
}) {
  const hasDetails = workspace.git || workspace.wikiId || proj?.project.dueAt;

  return (
    <div
      data-testid="workspace-mobile-header"
      class="flex items-center gap-2 border-b border-border px-2 py-2"
    >
      <button
        type="button"
        aria-label="Back to workspaces"
        class="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        onClick={() => route('/workspaces')}
      >
        <ArrowLeft class="size-5" />
      </button>

      <span
        class={cn(
          'size-2 shrink-0 rounded-full',
          isTerminal ? 'bg-muted-foreground' : isActive ? 'bg-green-500' : 'bg-amber-500',
        )}
        title={isTerminal ? 'Closed' : isActive ? 'Active' : 'Closing'}
      />

      <h1 class="min-w-0 flex-1 truncate text-base font-semibold">{workspace.name}</h1>

      {hasDetails && (
        <button
          type="button"
          data-testid="mobile-header-details-trigger"
          aria-label="Workspace details"
          class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:text-foreground"
          onClick={onOpenDetails}
        >
          {workspace.git && <GitBranch class="size-4" />}
          {workspace.wikiId && <BookOpen class="size-4" />}
          {proj?.project.dueAt && <Calendar class="size-4" />}
        </button>
      )}
    </div>
  );
}
