import { useSignal } from '@preact/signals';
import { X } from 'lucide-preact';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { patchWorkspace } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';

interface WorkspaceSettingsDrawerProps {
  workspace: Workspace;
  onClose: () => void;
  onSaved?: () => void;
}

export function WorkspaceSettingsDrawer({ workspace, onClose, onSaved }: WorkspaceSettingsDrawerProps) {
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
      onClose();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save.';
    } finally {
      saving.value = false;
    }
  }

  return (
    <>
      <div
        class="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
        aria-label="Close settings"
      />
      <div
        class="fixed top-0 right-0 bottom-0 z-50 w-[400px] border-l border-border bg-background shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.25)] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace settings"
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 class="font-semibold text-sm">Workspace settings</h2>
          <button
            type="button"
            onClick={onClose}
            class="rounded p-1 hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X class="size-4" />
          </button>
        </div>

        <form onSubmit={handleSave} class="flex flex-col flex-1 min-h-0">
          <div class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                autoFocus
                value={name.value}
                onInput={(e) => { name.value = (e.target as HTMLInputElement).value; }}
                required
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Description</label>
              <textarea
                placeholder="Describe this workspace"
                value={description.value}
                onInput={(e) => { description.value = (e.target as HTMLTextAreaElement).value; }}
                class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Goal</label>
              <textarea
                placeholder="What should be accomplished in this workspace?"
                value={goal.value}
                onInput={(e) => { goal.value = (e.target as HTMLTextAreaElement).value; }}
                class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Remote URL</label>
              <Input
                placeholder="https://github.com/org/repo"
                value={remoteUrl.value}
                onInput={(e) => { remoteUrl.value = (e.target as HTMLInputElement).value; }}
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

            {error.value && (
              <p class="text-sm text-destructive">{error.value}</p>
            )}
          </div>

          <div class="flex items-center gap-2 px-5 py-4 border-t border-border shrink-0 justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving.value}>
              {saving.value ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
