import { ChevronRight, ChevronDown, Folder, FileText, RefreshCw } from 'lucide-preact';

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
      class={cn(
        'ml-auto shrink-0 rounded px-1 text-[10px] font-semibold leading-4',
        STATUS_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function FileTreeRow({
  node,
  depth,
  workspaceId,
}: {
  node: FileNode;
  depth: number;
  workspaceId: string;
}) {
  const isDir = node.type === 'dir';
  const isExpanded = isDir && expandedFolders.value.has(node.path);

  return (
    <div>
      <button
        type="button"
        data-testid="file-tree-row"
        data-path={node.path}
        class="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => (isDir ? toggleFolder(node.path) : void openFile(workspaceId, node.path))}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span class="size-3.5 shrink-0" />
        )}
        {isDir ? (
          <Folder class="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileText class="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span class="truncate">{node.name}</span>
        {node.gitStatus && <GitStatusBadge status={node.gitStatus} />}
      </button>

      {isDir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              workspaceId={workspaceId}
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

  return (
    <div class="flex h-full flex-col" data-testid="file-tree">
      <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
        <span class="truncate" data-testid="file-tree-branch">
          {tree?.branch ? `git · ${tree.branch}` : ''}
        </span>
        <button
          type="button"
          aria-label="Refresh file tree"
          class="group shrink-0 rounded p-1 hover:bg-muted hover:text-foreground"
          onClick={(event: Event) => {
            const elem = event.currentTarget as HTMLButtonElement;

            elem.dataset.loading = 'true';

            loadFileTree(workspaceId, { force: true })
              .then(() => {
                console.log('File Tree Loaded')
                delete elem.dataset.loading;
              })
          }}
        >
          <RefreshCw
            class={cn(
              'size-3.5 group-data-loading:animate-spin'
            )}
          />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-1">
        {error ? (
          <div class="p-3 text-sm text-destructive" data-testid="file-tree-error">
            {error}
          </div>
        ) : tree && tree.entries.length > 0 ? (
          tree.entries.map((node) => (
            <FileTreeRow key={node.path} node={node} depth={0} workspaceId={workspaceId} />
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
