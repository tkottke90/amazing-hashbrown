import type { Signal } from '@preact/signals';
import { BottomSheet } from '@tkottke90/preact-dialog';
import type { ComponentChildren } from 'preact';

import { ThemeToggle } from '@/components/theme-toggle';
import { WorkspaceSettingsDrawer } from '@/pages/workspaces/workspace-settings-drawer';
import type { Workspace, Project } from '@/services/workspaces-api';

function ActionRow({ children }: { children: ComponentChildren }) {
  return (
    <div class="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0">
      {children}
    </div>
  );
}

// Secondary workspace actions, opened from the bottom app bar's "•••"
// (navEnd). Every row calls the exact same handler/component [id].tsx
// already owns — this only relocates where they're reached from. See the
// workspace mobile detail redesign design, §4.
export function WorkspaceActionsSheet({
  workspace,
  isTerminal,
  isProj,
  projectStatus,
  onSaved,
  onCloseIntent,
  onDelete,
  open,
}: {
  workspace: Workspace;
  isTerminal: boolean;
  isProj: boolean;
  projectStatus: Project['status'] | undefined;
  onSaved: () => void;
  onCloseIntent: (intent: 'close' | 'abandon') => void;
  onDelete: () => void;
  open: Signal<boolean>;
}) {
  return (
    <BottomSheet title="Actions" open={open}>
      <div class="flex flex-col px-1">
        {!isTerminal && (
          <ActionRow>
            <span class="text-sm font-medium">Edit workspace</span>
            <WorkspaceSettingsDrawer workspace={workspace} onSaved={onSaved} />
          </ActionRow>
        )}

        {isProj && projectStatus === 'active' && (
          <>
            <ActionRow>
              <span class="text-sm font-medium">Close project</span>
              <button
                type="button"
                data-testid="actions-close-project"
                class="rounded-md border border-border px-3 py-1.5 text-sm"
                onClick={() => onCloseIntent('close')}
              >
                Close
              </button>
            </ActionRow>
            <ActionRow>
              <span class="text-sm font-medium">Abandon project</span>
              <button
                type="button"
                data-testid="actions-abandon-project"
                class="rounded-md border border-border px-3 py-1.5 text-sm"
                onClick={() => onCloseIntent('abandon')}
              >
                Abandon
              </button>
            </ActionRow>
          </>
        )}

        <ActionRow>
          <span class="text-sm font-medium">Delete workspace</span>
          <button
            type="button"
            data-testid="actions-delete-workspace"
            class="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive"
            onClick={onDelete}
          >
            Delete
          </button>
        </ActionRow>

        <ActionRow>
          <span class="text-sm font-medium">Theme</span>
          <ThemeToggle />
        </ActionRow>
      </div>
    </BottomSheet>
  );
}
