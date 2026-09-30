import type { Signal } from '@preact/signals';
import { BottomSheet } from '@tkottke90/preact-dialog';
import type { ComponentChildren } from 'preact';
import { GitBranch, BookOpen, Calendar } from 'lucide-preact';

import { getProjectForWorkspace } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';
import { truncateStart } from '@/lib/utils';

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex items-center justify-between gap-4 border-b border-border py-3 text-sm last:border-b-0">
      <span class="text-muted-foreground">{label}</span>
      <span class="flex items-center gap-1.5 text-right font-medium">{children}</span>
    </div>
  );
}

// Read-only workspace metadata, opened from the mobile header's icon
// cluster. Pure presentation over data [id].tsx already computes — the
// desktop metadata chip row shows the same fields inline instead of in a
// sheet. See the workspace mobile detail redesign design, §3.
export function WorkspaceDetailsSheet({
  workspace,
  proj,
  open,
}: {
  workspace: Workspace;
  proj: ReturnType<typeof getProjectForWorkspace>;
  open: Signal<boolean>;
}) {
  return (
    <BottomSheet title="Details" open={open}>
      <div class="px-1">
        <DetailRow label="Location">
          <span class="font-mono text-xs" data-testid="details-location" title={workspace.location}>
            {truncateStart(workspace.location)}
          </span>
        </DetailRow>

        {workspace.git && (
          <DetailRow label="Git">
            <span data-testid="details-git" title={workspace.remoteUrl ?? undefined}>
              <GitBranch class="mr-1 inline size-3.5" />
              Git
            </span>
          </DetailRow>
        )}

        {workspace.wikiId && (
          <DetailRow label="Wiki">
            <a
              data-testid="details-wiki-link"
              href={`/wiki?view=document&domain=${encodeURIComponent(workspace.wikiId)}&page=index.md`}
              class="text-primary underline underline-offset-2"
            >
              <BookOpen class="mr-1 inline size-3.5" />
              {workspace.wikiId}
            </a>
          </DetailRow>
        )}

        {workspace.javascript && (
          <DetailRow label="JavaScript">
            <span data-testid="details-javascript">node_modules</span>
          </DetailRow>
        )}

        {workspace.python && (
          <DetailRow label="Python">
            <span data-testid="details-python">venv</span>
          </DetailRow>
        )}

        {proj?.project.dueAt && (
          <DetailRow label="Due">
            <span data-testid="details-due">
              <Calendar class="mr-1 inline size-3.5" />
              {new Date(proj.project.dueAt).toLocaleDateString()}
            </span>
          </DetailRow>
        )}
      </div>
    </BottomSheet>
  );
}
