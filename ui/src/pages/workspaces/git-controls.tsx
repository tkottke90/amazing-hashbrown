import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { GitBranch, Plus } from 'lucide-preact';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fetchGitStatus,
  fetchGitBranches,
  gitSync,
  gitPush,
  gitCheckout,
  gitCreateBranch,
  type GitStatus,
  type GitBranches,
} from '@/services/workspace-git-api';
import { loadFileTree } from '@/hooks/use-workspace-files';

interface GitControlsProps {
  workspaceId: string;
  git: boolean;
}

// Shown in the Files tab's header, next to the branch/status the tab already
// renders from the file-tree response. Owns its own gating on the
// workspace's git flag (rather than the caller conditionally mounting it) so
// the gating behavior lives in one tested place — mirrors the existing
// git-chip gating pattern in [id].tsx, just moved inside this component.
export function GitControls({ workspaceId, git }: GitControlsProps) {
  const status = useSignal<GitStatus | null>(null);
  const branches = useSignal<GitBranches>({ local: [], remote: [] });
  const loading = useSignal(true);
  const syncing = useSignal(false);
  const pushing = useSignal(false);
  const switching = useSignal(false);
  const creatingBranch = useSignal(false);
  const newBranchName = useSignal('');
  const showNewBranchInput = useSignal(false);
  const error = useSignal('');

  async function loadStatus() {
    loading.value = true;
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        fetchGitStatus(workspaceId),
        fetchGitBranches(workspaceId),
      ]);
      status.value = nextStatus;
      branches.value = nextBranches;
      error.value = '';
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load git status.';
    } finally {
      loading.value = false;
    }
  }

  useEffect(() => {
    if (!git) return;
    void loadStatus();
  }, [workspaceId, git]);

  function applyStatus(next: GitStatus) {
    status.value = next;
    error.value = '';
    void loadFileTree(workspaceId, { force: true });
  }

  async function handleSync() {
    syncing.value = true;
    try {
      applyStatus(await gitSync(workspaceId));
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Sync failed.';
    } finally {
      syncing.value = false;
    }
  }

  async function handlePush() {
    pushing.value = true;
    try {
      applyStatus(await gitPush(workspaceId));
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Push failed.';
    } finally {
      pushing.value = false;
    }
  }

  async function handleCheckout(branch: string) {
    switching.value = true;
    try {
      applyStatus(await gitCheckout(workspaceId, branch));
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Checkout failed.';
    } finally {
      switching.value = false;
    }
  }

  async function handleCreateBranch() {
    const name = newBranchName.value.trim();
    if (!name) return;
    creatingBranch.value = true;
    try {
      applyStatus(await gitCreateBranch(workspaceId, name));
      newBranchName.value = '';
      showNewBranchInput.value = false;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to create branch.';
    } finally {
      creatingBranch.value = false;
    }
  }

  if (!git) return null;

  const busy = syncing.value || pushing.value || switching.value || creatingBranch.value;
  const currentBranch = status.value?.branch ?? null;
  const branchOptions = currentBranch
    ? Array.from(new Set([currentBranch, ...branches.value.local, ...branches.value.remote]))
    : [...branches.value.local, ...branches.value.remote];

  return (
    <div class="flex flex-col gap-2 border-b border-border px-3 py-2">
      <div class="flex items-center gap-2 flex-wrap">
        <GitBranch class="size-3.5 text-muted-foreground shrink-0" />

        {loading.value ? (
          <span class="text-xs text-muted-foreground">Loading git status…</span>
        ) : (
          <>
            <Select
              value={currentBranch ?? ''}
              onValueChange={(value) => {
                if (value && value !== currentBranch) void handleCheckout(value);
              }}
            >
              <SelectTrigger size="sm" disabled={busy}>
                <SelectValue>{currentBranch ?? '(detached)'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branchOptions.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {status.value?.hasRemote && (status.value.ahead > 0 || status.value.behind > 0) && (
              <span class="text-xs text-muted-foreground" data-testid="git-ahead-behind">
                {status.value.ahead > 0 && `↑${status.value.ahead}`}
                {status.value.behind > 0 && `↓${status.value.behind}`}
              </span>
            )}

            <Button size="xs" variant="outline" disabled={busy} onClick={() => void handleSync()}>
              {syncing.value ? 'Syncing…' : 'Sync'}
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void handlePush()}>
              {pushing.value ? 'Pushing…' : 'Push'}
            </Button>

            {showNewBranchInput.value ? (
              <div class="flex items-center gap-1">
                <Input
                  autoFocus
                  className="h-7 text-xs w-40"
                  placeholder="new-branch-name"
                  value={newBranchName.value}
                  onInput={(e) => {
                    newBranchName.value = (e.target as HTMLInputElement).value;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateBranch();
                  }}
                />
                <Button size="xs" disabled={busy} onClick={() => void handleCreateBranch()}>
                  {creatingBranch.value ? 'Creating…' : 'Create'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    showNewBranchInput.value = false;
                    newBranchName.value = '';
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  showNewBranchInput.value = true;
                }}
              >
                <Plus class="size-3" />
                New branch
              </Button>
            )}
          </>
        )}
      </div>

      {error.value && (
        <p class="text-xs text-destructive" data-testid="git-controls-error">
          {error.value}
        </p>
      )}
    </div>
  );
}
