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
  activateTab,
  saveTab,
  overwriteTab,
  discardConflict,
  discardTab,
  closeTab,
  applyAgentResolveProposals,
  type OpenTab,
} from '@/hooks/use-workspace-files';
import { useThreadInstance } from '@/hooks/use-thread';
import { mediaMuted, toggleMediaMuted } from '@/hooks/use-media-mute';

// Its own subcomponent so a keystroke in one tab's editor (which flips only
// that tab's `dirty` signal) re-renders just this button, not the whole tab
// bar.
function TabButton({
  workspaceId,
  tab,
  isActive,
}: {
  workspaceId: string;
  tab: OpenTab;
  isActive: boolean;
}) {
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
        void activateTab(workspaceId, tab.path);
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

function ConflictBanner({
  workspaceId,
  tab,
  onAgentResolve,
}: {
  workspaceId: string;
  tab: OpenTab;
  onAgentResolve: (path: string) => void;
}) {
  if (!tab.conflict) return null;
  const deleted = tab.conflict.currentHash === '';

  return (
    <div
      data-testid="file-conflict-banner"
      class="flex items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
    >
      <span>
        {deleted
          ? 'This file was deleted on disk since you opened it.'
          : 'This file changed on disk since you opened it — saving will overwrite those changes.'}
      </span>
      <div class="flex items-center gap-1.5">
        {!deleted && (
          <Button
            size="xs"
            variant="destructive"
            onClick={() => overwriteTab(workspaceId, tab.path)}
          >
            Overwrite
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => discardConflict(tab.path)}>
          Discard my edits
        </Button>
        {!deleted && (
          <Button size="xs" variant="outline" onClick={() => onAgentResolve(tab.path)}>
            Agent Resolve
          </Button>
        )}
      </div>
    </div>
  );
}

function EditorPanel({
  workspaceId,
  tab,
  onAgentResolve,
}: {
  workspaceId: string;
  tab: OpenTab;
  onAgentResolve: (path: string) => void;
}) {
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

  if (tab.deletedOnDisk) {
    return (
      <div
        data-testid="file-deleted-on-disk"
        class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <span>This file was deleted on disk.</span>
        <Button size="xs" variant="outline" onClick={() => closeTab(tab.path)}>
          Close tab
        </Button>
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
          <ConflictBanner workspaceId={workspaceId} tab={tab} onAgentResolve={onAgentResolve} />
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
function EditorPanes({
  workspaceId,
  onAgentResolve,
}: {
  workspaceId: string;
  onAgentResolve: (path: string) => void;
}) {
  return (
    <>
      {openTabs.value.map((tab) => (
        <div
          key={tab.path}
          data-testid="file-editor-pane"
          data-path={tab.path}
          class={cn('h-full', activeTabPath.value !== tab.path && 'hidden')}
        >
          <EditorPanel workspaceId={workspaceId} tab={tab} onAgentResolve={onAgentResolve} />
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
  onAgentResolve,
}: {
  workspaceId: string;
  git: boolean;
  uploadRequest?: Signal<number>;
  onAgentResolve: (path: string) => void;
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
          <EditorPanes workspaceId={workspaceId} onAgentResolve={onAgentResolve} />
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
  threadId,
  onGoToChat,
}: {
  workspaceId: string;
  git: boolean;
  // Incremented by the mobile bottom app bar's "+" (see [id].tsx) — passed
  // through to FileTree's mobile upload trigger. Unused on desktop, which
  // keeps its own always-visible upload icon in FileTree's header.
  uploadRequest?: Signal<number>;
  // Both needed for Agent Resolve: posting the composed conflict message
  // into the workspace's chat thread, and switching the user there to
  // watch it happen (see docs/superpowers/specs/2026-10-12-workspace-file-
  // explorer-sync-and-delete-design.md §2).
  threadId?: string | null;
  onGoToChat: () => void;
}) {
  useEffect(() => {
    void loadFileTree(workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    if (!threadId) return;
    const thread = useThreadInstance(threadId, {
      endpointBase: `/api/v1/workspaces/${workspaceId}/chat`,
      readUrl: `/api/v1/workspaces/${workspaceId}/chat/${threadId}`,
    });
    return applyAgentResolveProposals(thread);
  }, [workspaceId, threadId]);

  function handleAgentResolve(path: string): void {
    const tab = openTabs.value.find((t) => t.path === path);
    if (!tab || !tab.view || !tab.conflict || !threadId) return;
    const draft = tab.view.state.doc.toString();
    const composed = `/resolve-file-conflict ${path}\n\nDraft:\n${draft}\n\nOn-disk:\n${tab.conflict.onDiskContent}`;
    const thread = useThreadInstance(threadId, {
      endpointBase: `/api/v1/workspaces/${workspaceId}/chat`,
      readUrl: `/api/v1/workspaces/${workspaceId}/chat/${threadId}`,
    });
    onGoToChat();
    void thread.sendMessage(composed);
  }

  const desktop = useIsDesktopViewport();

  if (!desktop) {
    return (
      <div class="p-4 size-full">
        <MobileFilesTab
          workspaceId={workspaceId}
          git={git}
          uploadRequest={uploadRequest}
          onAgentResolve={handleAgentResolve}
        />
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
                <TabButton
                  key={tab.path}
                  workspaceId={workspaceId}
                  tab={tab}
                  isActive={activeTabPath.value === tab.path}
                />
              ))}
            </div>
          )}

          <div class="min-h-0 flex-1">
            {openTabs.value.length === 0 ? (
              <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a file to view its contents.
              </div>
            ) : (
              <EditorPanes workspaceId={workspaceId} onAgentResolve={handleAgentResolve} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
