import { useSignal } from '@preact/signals';

import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { patchWorkspace } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';

interface WorkspaceSettingsDrawerProps {
  workspace: Workspace;
  onSaved?: () => void;
}

export function WorkspaceSettingsDrawer({ workspace, onSaved }: WorkspaceSettingsDrawerProps) {
  return (
    <Drawer
      title="Workspace settings"
      className="!p-0 !bg-background !rounded-none !border-0 border-l border-border"
      trigger={
        <Button size="sm" variant="outline">
          Edit
        </Button>
      }
    >
      <WorkspaceSettingsForm workspace={workspace} onSaved={onSaved} />
    </Drawer>
  );
}

interface WorkspaceSettingsFormProps {
  workspace: Workspace;
  onSaved?: () => void;
}

function WorkspaceSettingsForm({ workspace, onSaved }: WorkspaceSettingsFormProps) {
  const { close } = useDialog();

  const name = useSignal(workspace.name);
  const description = useSignal(workspace.description ?? '');
  const goal = useSignal(workspace.goal ?? '');
  const remoteUrl = useSignal(workspace.remoteUrl ?? '');
  const saving = useSignal(false);
  const error = useSignal('');

  async function handleSave(e: Event) {
    e.preventDefault();
    if (!name.value.trim()) {
      error.value = 'Name is required.';
      return;
    }
    saving.value = true;
    error.value = '';
    try {
      await patchWorkspace(workspace.id, {
        name: name.value.trim(),
        description: description.value.trim() || null,
        goal: goal.value.trim() || null,
        remoteUrl: remoteUrl.value.trim() || null,
      });
      onSaved?.();
      close();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save.';
    } finally {
      saving.value = false;
    }
  }

  return (
    <form onSubmit={handleSave} class="flex flex-col min-h-0 mt-2">
      <div class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Name</label>
          <Input
            autoFocus
            value={name.value}
            onInput={(e) => {
              name.value = (e.target as HTMLInputElement).value;
            }}
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Description</label>
          <textarea
            placeholder="Describe this workspace"
            value={description.value}
            onInput={(e) => {
              description.value = (e.target as HTMLTextAreaElement).value;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Goal</label>
          <textarea
            placeholder="What should be accomplished in this workspace?"
            value={goal.value}
            onInput={(e) => {
              goal.value = (e.target as HTMLTextAreaElement).value;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Remote URL</label>
          <Input
            placeholder="https://github.com/org/repo"
            value={remoteUrl.value}
            onInput={(e) => {
              remoteUrl.value = (e.target as HTMLInputElement).value;
            }}
          />
        </div>

        <div class="border border-border rounded-lg p-3 bg-muted/30">
          <p class="text-xs font-medium text-muted-foreground mb-2">Read-only after creation</p>
          <div class="flex flex-col gap-2 text-sm">
            <div class="flex justify-between">
              <span class="text-muted-foreground">Location</span>
              <code class="text-xs bg-muted px-1.5 py-0.5 rounded">{workspace.location}</code>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">JavaScript</span>
              <span>{workspace.javascript ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">Python</span>
              <span>{workspace.python ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">Git</span>
              <span>{workspace.git ? 'Yes' : 'No'}</span>
            </div>
            {workspace.wikiId && (
              <div class="flex justify-between">
                <span class="text-muted-foreground">Wiki</span>
                <code class="text-xs bg-muted px-1.5 py-0.5 rounded">{workspace.wikiId}</code>
              </div>
            )}
          </div>
        </div>

        {error.value && <p class="text-sm text-destructive">{error.value}</p>}
      </div>

      <div class="flex items-center gap-2 px-5 py-4 border-t border-border shrink-0 justify-end">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving.value}>
          {saving.value ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
