import { useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  RefreshCw,
  AlertTriangle,
  FileWarning,
  Upload,
  FilePlus,
  FolderPlus,
} from 'lucide-preact';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import type { JSX } from 'preact';

import { cn } from '@/lib/utils';
import type { FileNode } from '@/services/workspace-files-api';
import {
  fileTree,
  fileTreeError,
  fileTreeLoading,
  expandedFolders,
  loadFileTree,
  toggleFolder,
  openFile,
  uploadFiles,
  createDirectory,
  createFile,
} from '@/hooks/use-workspace-files';

const STATUS_LABEL: Record<'M' | 'A', string> = { M: 'M', A: 'A' };

const STATUS_CLASS: Record<'M' | 'A', string> = {
  M: 'bg-amber-500/15 text-amber-600',
  A: 'bg-green-500/15 text-green-600',
};

function GitStatusBadge({ status }: { status: 'M' | 'A' }) {
  return (
    <span
      data-testid="file-tree-status"
      class={cn('shrink-0 rounded px-1 text-[10px] font-semibold leading-4', STATUS_CLASS[status])}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function UnsupportedBadge() {
  return (
    <AlertTriangle
      data-testid="file-tree-unsupported"
      title="Can't preview this file type"
      class="size-3.5 shrink-0 text-amber-600"
    />
  );
}

function OversizeBadge() {
  return (
    <FileWarning
      data-testid="file-tree-oversize"
      title="File is too large to open"
      class="size-3.5 shrink-0 text-slate-500"
    />
  );
}

// Shared name-input modal for both "new file" and "new directory" — the only
// difference between the two is which create action it calls and its title.
function CreateEntryForm({
  workspaceId,
  dir,
  kind,
}: {
  workspaceId: string;
  dir: string;
  kind: 'file' | 'directory';
}) {
  const name = useSignal('');
  const error = useSignal<string | null>(null);
  const { close } = useDialog();

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = name.value.trim();
    if (!trimmed) return;

    const action = kind === 'file' ? createFile : createDirectory;
    const result = await action(workspaceId, dir, trimmed);
    if (!result.ok) {
      error.value = result.error;
      return;
    }

    name.value = '';
    error.value = null;
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-3">
      <input
        type="text"
        placeholder={kind === 'file' ? 'File name (e.g. notes.txt)' : 'Folder name'}
        value={name.value}
        onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
        class="rounded border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        required
      />
      {error.value && (
        <span data-testid="create-entry-error" class="text-xs text-destructive">
          {error.value}
        </span>
      )}
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => close()}
          class="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          Create
        </button>
      </div>
    </form>
  );
}

function CreateEntryModal({
  workspaceId,
  dir,
  kind,
  trigger,
}: {
  workspaceId: string;
  dir: string;
  kind: 'file' | 'directory';
  trigger: JSX.Element;
}) {
  return (
    <Modal
      title={kind === 'file' ? 'New File' : 'New Folder'}
      className="mx-auto my-16 max-w-sm p-4"
      trigger={trigger}
    >
      <CreateEntryForm workspaceId={workspaceId} dir={dir} kind={kind} />
    </Modal>
  );
}

// The 3 actions (upload / new file / new folder) targeting `dir` — rendered
// both in the tree header (dir: '', alwaysVisible) and on every directory
// row (dir: that folder's path, revealed on hover/focus unless alwaysVisible
// is set). Deliberately no `pointer-events-none` paired with the opacity-0
// hover-hidden state: Playwright's click() actionability check runs before
// it moves the mouse, so gating pointer-events behind real :hover would
// require every e2e interaction to call .hover() first just to avoid a
// false "not clickable" failure. Opacity-only hiding avoids that flakiness
// for the minor cost of a technically-clickable-if-invisible button.
function FolderActionIcons({
  workspaceId,
  dir,
  onUploadClick,
  alwaysVisible = false,
}: {
  workspaceId: string;
  dir: string;
  onUploadClick: (dir: string) => void;
  alwaysVisible?: boolean;
}) {
  return (
    <span
      class={cn(
        'flex shrink-0 items-center gap-0.5',
        !alwaysVisible && 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      )}
    >
      <button
        type="button"
        data-testid="folder-action-upload"
        aria-label="Upload files"
        title="Upload files"
        class="rounded p-0.5 hover:bg-background"
        onClick={(e: Event) => {
          e.stopPropagation();
          onUploadClick(dir);
        }}
      >
        <Upload class="size-3.5 text-muted-foreground" />
      </button>
      <CreateEntryModal
        workspaceId={workspaceId}
        dir={dir}
        kind="file"
        trigger={
          <button
            type="button"
            data-testid="folder-action-new-file"
            aria-label="New file"
            title="New file"
            class="rounded p-0.5 hover:bg-background"
          >
            <FilePlus class="size-3.5 text-muted-foreground" />
          </button>
        }
      />
      <CreateEntryModal
        workspaceId={workspaceId}
        dir={dir}
        kind="directory"
        trigger={
          <button
            type="button"
            data-testid="folder-action-new-folder"
            aria-label="New folder"
            title="New folder"
            class="rounded p-0.5 hover:bg-background"
          >
            <FolderPlus class="size-3.5 text-muted-foreground" />
          </button>
        }
      />
    </span>
  );
}

function FileTreeRow({
  node,
  depth,
  workspaceId,
  onUploadClick,
}: {
  node: FileNode;
  depth: number;
  workspaceId: string;
  onUploadClick: (dir: string) => void;
}) {
  const isDir = node.type === 'dir';
  const isExpanded = isDir && expandedFolders.value.has(node.path);

  return (
    <div>
      <div
        data-testid="file-tree-row"
        data-path={node.path}
        class="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-sm hover:bg-muted"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {isDir ? (
          <span
            role="button"
            tabIndex={0}
            data-testid="file-tree-chevron"
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
            class="shrink-0"
            onClick={(e: Event) => {
              e.stopPropagation();
              toggleFolder(node.path);
            }}
          >
            {isExpanded ? (
              <ChevronDown class="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight class="size-3.5 text-muted-foreground" />
            )}
          </span>
        ) : (
          <span class="size-3.5 shrink-0" />
        )}

        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => (isDir ? toggleFolder(node.path) : void openFile(workspaceId, node))}
        >
          {isDir ? (
            <Folder class="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileText class="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span class="truncate">{node.name}</span>
        </button>

        <span class="ml-auto flex shrink-0 items-center gap-1">
          {node.gitStatus && <GitStatusBadge status={node.gitStatus} />}
          {node.category === 'unsupported' && <UnsupportedBadge />}
          {node.oversize && <OversizeBadge />}
          {isDir && (
            <FolderActionIcons
              workspaceId={workspaceId}
              dir={node.path}
              onUploadClick={onUploadClick}
            />
          )}
        </span>
      </div>

      {isDir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              workspaceId={workspaceId}
              onUploadClick={onUploadClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ workspaceId }: { workspaceId: string }) {
  const tree = fileTree.value;
  const error = fileTreeError.value;

  // One shared hidden file input for every Upload icon (header + rows) — the
  // pending target directory is stashed in a ref just before it's clicked,
  // since a native file input carries no notion of "which folder triggered
  // this".
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadDir = useRef('');

  // Its own local signal, deliberately NOT fileTreeError — that one replaces
  // the whole tree view with an error state (see the render below), which
  // would hide the tree exactly when an upload conflict needs the user to
  // look at it (e.g. to pick a different name).
  const uploadError = useSignal<string | null>(null);

  function triggerUpload(dir: string): void {
    uploadError.value = null;
    pendingUploadDir.current = dir;
    fileInputRef.current?.click();
  }

  async function handleFileInputChange(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    const result = await uploadFiles(workspaceId, pendingUploadDir.current, files);
    uploadError.value = result.ok
      ? null
      : result.conflicts?.length
        ? `${result.error} (${result.conflicts.join(', ')})`
        : result.error;
    input.value = ''; // allow re-selecting the same file(s) on a retry
  }

  return (
    <div class="flex h-full flex-col" data-testid="file-tree">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        class="hidden"
        data-testid="file-upload-input"
        onChange={(e) => void handleFileInputChange(e)}
      />

      <div
        data-testid="file-tree-header"
        class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
      >
        <span class="truncate" data-testid="file-tree-branch">
          {tree?.branch ? `git · ${tree.branch}` : ''}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <FolderActionIcons
            workspaceId={workspaceId}
            dir=""
            onUploadClick={triggerUpload}
            alwaysVisible
          />
          <button
            type="button"
            aria-label="Refresh file tree"
            class="group shrink-0 rounded p-1 hover:bg-muted hover:text-foreground"
            onClick={(event: Event) => {
              const elem = event.currentTarget as HTMLButtonElement;

              elem.dataset.loading = 'true';

              loadFileTree(workspaceId, { force: true }).then(() => {
                console.log('File Tree Loaded');
                delete elem.dataset.loading;
              });
            }}
          >
            <RefreshCw class={cn('size-3.5 group-data-loading:animate-spin')} />
          </button>
        </div>
      </div>

      {uploadError.value && (
        <div
          class="border-b border-border px-2 py-1.5 text-xs text-destructive"
          data-testid="upload-error"
        >
          {uploadError.value}
        </div>
      )}

      <div class="flex-1 overflow-y-auto p-1">
        {error ? (
          <div class="p-3 text-sm text-destructive" data-testid="file-tree-error">
            {error}
          </div>
        ) : tree && tree.entries.length > 0 ? (
          tree.entries.map((node) => (
            <FileTreeRow
              key={node.path}
              node={node}
              depth={0}
              workspaceId={workspaceId}
              onUploadClick={triggerUpload}
            />
          ))
        ) : (
          <div class="p-3 text-sm text-muted-foreground">
            {fileTreeLoading.value ? 'Loading…' : 'No files.'}
          </div>
        )}
      </div>
    </div>
  );
}
