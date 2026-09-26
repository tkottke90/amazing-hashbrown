import type { Workspace } from '@/services/workspaces-api';
import type { GitStatus } from '@/services/workspace-git-api';

// Builds the native confirm() text for deleting a workspace. It has to be
// honest about what happens on disk: a managed directory is deleted for
// good (with a warning when git has local-only work in it), while an
// unmanaged legacy location is left alone.
export function buildDeleteConfirmMessage(
  ws: Pick<Workspace, 'name' | 'location' | 'managedLocation'>,
  gitStatus: Pick<GitStatus, 'dirty' | 'ahead'> | null,
): string {
  if (!ws.managedLocation) {
    return `Delete workspace "${ws.name}"? Files at ${ws.location} are outside the app's managed directories and will be kept on disk.`;
  }

  const message = `Delete workspace "${ws.name}"? This permanently deletes ${ws.location} and everything in it. This cannot be undone.`;
  const warning = gitStatus ? localWorkWarning(gitStatus) : null;
  return warning ? `${message}\n\n${warning}` : message;
}

function localWorkWarning({ dirty, ahead }: Pick<GitStatus, 'dirty' | 'ahead'>): string | null {
  const parts: string[] = [];
  if (dirty) parts.push('uncommitted changes');
  if (ahead > 0) parts.push(`${ahead} unpushed ${ahead === 1 ? 'commit' : 'commits'}`);
  if (parts.length === 0) return null;
  return `⚠ This repository has ${parts.join(' and ')} that will be lost.`;
}
