import { useEffect } from 'preact/hooks';
import { X } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { FileTree } from '@/pages/workspaces/file-tree';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import {
  openTabs,
  activeTabPath,
  loadFileTree,
  setTabView,
  saveTab,
  discardTab,
  closeTab,
  type OpenTab,
} from '@/hooks/use-workspace-files';

// Its own subcomponent so a keystroke in one tab's editor (which flips only
// that tab's `dirty` signal) re-renders just this button, not the whole tab
// bar.
function TabButton({ tab, isActive }: { tab: OpenTab; isActive: boolean }) {
  const fileName = tab.path.split('/').pop() ?? tab.path;

  return (
    <button
      type="button"
      data-testid="file-tab"
      data-path={tab.path}
      class={cn(
        'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors',
        isActive
          ? 'border-primary text-foreground font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      onClick={() => {
        activeTabPath.value = tab.path;
      }}
    >
      <span class="max-w-40 truncate" title={tab.path}>
        {fileName}
      </span>
      {tab.dirty.value && (
        <span data-testid="tab-unsaved-dot" class="size-1.5 shrink-0 rounded-full bg-primary" />
      )}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Close ${fileName}`}
        class="shrink-0 rounded p-0.5 hover:bg-muted"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.path);
        }}
      >
        <X class="size-3" />
      </span>
    </button>
  );
}

function EditorPanel({ workspaceId, tab }: { workspaceId: string; tab: OpenTab }) {
  if (tab.unsupported) {
    return (
      <div
        data-testid="file-unsupported"
        class="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Can&apos;t display this file.
      </div>
    );
  }

  if (tab.error && !tab.view) {
    return (
      <div data-testid="file-editor-error" class="p-3 text-sm text-destructive">
        {tab.error}
      </div>
    );
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <div class="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void saveTab(workspaceId, tab.path)}>
            Save
          </Button>
          <Button size="xs" variant="ghost" onClick={() => discardTab(tab.path)}>
            Discard
          </Button>
        </div>
        {tab.error && (
          <span data-testid="file-editor-error" class="truncate text-xs text-destructive">
            {tab.error}
          </span>
        )}
      </div>
      <div class="flex-1 min-h-0">
        <CodeEditor
          path={tab.path}
          initialContent={tab.savedContent}
          dirty={tab.dirty}
          onReady={(view) => setTabView(tab.path, view)}
        />
      </div>
    </div>
  );
}

export function FilesTab({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    void loadFileTree(workspaceId);
  }, [workspaceId]);

  return (
    <div class="p-4 size-full">
      <div class="flex gap-4 size-full">
        <div class="w-[250px] shrink-0 overflow-hidden rounded-xl border border-border">
          <FileTree workspaceId={workspaceId} />
        </div>

        <div class="flex flex-1 min-w-0 flex-col overflow-hidden rounded-xl border border-border">
          {openTabs.value.length > 0 && (
            <div class="flex items-center gap-1 overflow-x-auto border-b border-border px-1">
              {openTabs.value.map((tab) => (
                <TabButton key={tab.path} tab={tab} isActive={activeTabPath.value === tab.path} />
              ))}
            </div>
          )}

          <div class="min-h-0 flex-1">
            {openTabs.value.length === 0 ? (
              <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a file to view its contents.
              </div>
            ) : (
              // All open tabs stay mounted simultaneously (hidden via CSS,
              // not destroyed/recreated on switch) so cursor/scroll/undo
              // history survive a tab switch.
              openTabs.value.map((tab) => (
                <div
                  key={tab.path}
                  data-testid="file-editor-pane"
                  data-path={tab.path}
                  class={cn('h-full', activeTabPath.value !== tab.path && 'hidden')}
                >
                  <EditorPanel workspaceId={workspaceId} tab={tab} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
