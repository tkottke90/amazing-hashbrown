import { useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { X, Volume2, VolumeX, ArrowLeft } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { FileTree } from '@/pages/workspaces/file-tree';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import { GitControls } from '@/pages/workspaces/git-controls';
import { useIsDesktopViewport } from '@/hooks/use-media-query';
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
import { mediaMuted, toggleMediaMuted } from '@/hooks/use-media-mute';

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

  switch (tab.category) {
    case 'image':
      return (
        <div class="flex h-full items-center justify-center p-4">
          <img
            data-testid="file-image"
            src={tab.contentUrl}
            alt={tab.path}
            class="max-h-full max-w-full object-contain"
          />
        </div>
      );

    case 'audio':
    case 'video': {
      const muted = mediaMuted.value || activeTabPath.value !== tab.path;
      return (
        <div class="flex h-full flex-col">
          <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Button
              size="xs"
              variant="outline"
              data-testid="media-mute-toggle"
              aria-label={mediaMuted.value ? 'Unmute media' : 'Mute media'}
              onClick={toggleMediaMuted}
            >
              {mediaMuted.value ? <VolumeX class="size-3.5" /> : <Volume2 class="size-3.5" />}
              {mediaMuted.value ? 'Unmute' : 'Mute'}
            </Button>
          </div>
          <div class="flex flex-1 items-center justify-center p-4">
            {tab.category === 'video' ? (
              <video
                data-testid="file-video"
                src={tab.contentUrl}
                controls
                muted={muted}
                class="max-h-full max-w-full"
              />
            ) : (
              <audio
                data-testid="file-audio"
                src={tab.contentUrl}
                controls
                muted={muted}
                class="w-full"
              />
            )}
          </div>
        </div>
      );
    }

    case 'text':
    default:
      return (
        <div class="flex h-full flex-col">
          <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
            <div class="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void saveTab(workspaceId, tab.path)}
              >
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
}

// All open tabs stay mounted simultaneously (hidden via CSS, not
// destroyed/recreated on switch) so cursor/scroll/undo history survive a
// tab switch — shared by the desktop split pane and the mobile single pane.
function EditorPanes({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      {openTabs.value.map((tab) => (
        <div
          key={tab.path}
          data-testid="file-editor-pane"
          data-path={tab.path}
          class={cn('h-full', activeTabPath.value !== tab.path && 'hidden')}
        >
          <EditorPanel workspaceId={workspaceId} tab={tab} />
        </div>
      ))}
    </>
  );
}

// Below `lg`, the fixed 250px-tree + editor split pane has no room to
// exist — one full-width pane at a time instead: the tree, or (once a file
// is opened) that file's editor with a back arrow. Desktop is untouched.
// See the workspace mobile detail redesign design, §6.
function MobileFilesTab({
  workspaceId,
  git,
  uploadRequest,
}: {
  workspaceId: string;
  git: boolean;
  uploadRequest?: Signal<number>;
}) {
  const activeTab = openTabs.value.find((tab) => tab.path === activeTabPath.value) ?? null;

  if (activeTab) {
    const fileName = activeTab.path.split('/').pop() ?? activeTab.path;
    return (
      <div class="flex size-full flex-col overflow-hidden rounded-xl border border-border">
        <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <button
            type="button"
            aria-label="Back to files"
            data-testid="files-mobile-back"
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            onClick={() => {
              activeTabPath.value = null;
            }}
          >
            <ArrowLeft class="size-4" />
          </button>
          <span class="truncate text-sm font-medium" title={activeTab.path}>
            {fileName}
          </span>
        </div>
        <div class="min-h-0 flex-1">
          <EditorPanes workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  return (
    <div class="flex size-full flex-col overflow-hidden rounded-xl border border-border">
      <GitControls workspaceId={workspaceId} git={git} />
      <div class="min-h-0 flex-1 overflow-hidden">
        <FileTree workspaceId={workspaceId} hideUploadAction uploadRequest={uploadRequest} />
      </div>
    </div>
  );
}

export function FilesTab({
  workspaceId,
  git,
  uploadRequest,
}: {
  workspaceId: string;
  git: boolean;
  // Incremented by the mobile bottom app bar's "+" (see [id].tsx) — passed
  // through to FileTree's mobile upload trigger. Unused on desktop, which
  // keeps its own always-visible upload icon in FileTree's header.
  uploadRequest?: Signal<number>;
}) {
  useEffect(() => {
    void loadFileTree(workspaceId);
  }, [workspaceId]);

  const desktop = useIsDesktopViewport();

  if (!desktop) {
    return (
      <div class="p-4 size-full">
        <MobileFilesTab workspaceId={workspaceId} git={git} uploadRequest={uploadRequest} />
      </div>
    );
  }

  return (
    <div class="p-4 size-full">
      <div class="flex gap-4 size-full">
        <div class="w-[250px] shrink-0 overflow-hidden rounded-xl border border-border">
          <FileTree workspaceId={workspaceId} />
        </div>

        <div class="flex flex-1 min-w-0 flex-col overflow-hidden rounded-xl border border-border">
          <GitControls workspaceId={workspaceId} git={git} />

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
              <EditorPanes workspaceId={workspaceId} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
