import { signal, effect, type Signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';

import {
  fetchFileTree,
  fetchFileContent,
  saveFile,
  deleteFileEntry as deleteFileEntryApi,
  uploadFiles as uploadFilesApi,
  createDirectory as createDirectoryApi,
  createFile as createFileApi,
  FileFetchError,
  SaveConflictError,
  type FileTreeResponse,
  type FileNode,
  type UploadResult,
  type CreateEntryResult,
  type DeleteEntryResult,
} from '@/services/workspace-files-api';
import type { ThreadInstance } from './use-thread';

export const fileTree = signal<FileTreeResponse | null>(null);
export const fileTreeLoading = signal(false);
export const fileTreeError = signal<string | null>(null);
export const expandedFolders = signal<Set<string>>(new Set());

export interface OpenTab {
  path: string;
  contentUrl: string; // node.content — used for GET (text/media) and PATCH (text)
  category: 'text' | 'image' | 'audio' | 'video' | 'unsupported';
  view: EditorView | null; // set once by CodeEditor's mount effect via setTabView
  savedContent: string;
  baseHash: string; // '' for binary/unsupported/error tabs — the staleness check is text-only
  dirty: Signal<boolean>; // ONE signal per tab — never a shared array/object signal
  error?: string; // deleted-on-disk / fetch-failure case
  unsupported?: boolean; // binary/oversized case — no view, no content
  // Set only when a reactivation check finds the on-disk file changed while
  // the tab was dirty — drives the conflict banner. currentHash === '' is
  // the "deleted on disk" sentinel, which hides the Overwrite/Agent Resolve
  // actions (nothing to overwrite or merge against).
  conflict?: { currentHash: string; onDiskContent: string } | null;
  // Set when a reactivation check finds the file gone while the tab was
  // clean — nothing to protect, so this replaces the editor with a plain
  // "deleted" state rather than the conflict banner.
  deletedOnDisk?: boolean;
}

export const openTabs = signal<OpenTab[]>([]);
export const activeTabPath = signal<string | null>(null);

export async function loadFileTree(
  workspaceId: string,
  // force is accepted for signature parity with the plan/callers (refresh
  // button, post-save re-fetch) — the server owns the real TTL cache, so
  // this hook always issues a fresh request either way.
  _opts: { force?: boolean } = {},
): Promise<void> {
  fileTreeLoading.value = true;
  try {
    const tree = await fetchFileTree(workspaceId);
    fileTree.value = tree;
    fileTreeError.value = null;
  } catch (err) {
    fileTreeError.value = err instanceof Error ? err.message : 'Failed to load file tree';
  } finally {
    fileTreeLoading.value = false;
  }
}

export function toggleFolder(path: string): void {
  const next = new Set(expandedFolders.value);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  expandedFolders.value = next;
}

function expandFolder(path: string): void {
  if (!path || expandedFolders.value.has(path)) return;
  expandedFolders.value = new Set(expandedFolders.value).add(path);
}

// Depth-first search of the (nested) tree for a node by its relative path —
// needed after creating a new file, since the create-file response doesn't
// carry a content URL (see createFile() below for why).
function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

// The single shared reactivation check — runs whenever an already-open tab
// is (re)activated, whether via a tree-row click (openFile's early-return
// below) or the tab-strip's own click handler. Only text tabs have a
// dirty/editable draft to protect or stale content to refresh; binary
// (image/audio/video) and unsupported tabs never had staleness protection
// and don't gain any here.
export async function activateTab(workspaceId: string, path: string): Promise<void> {
  const existing = openTabs.value.find((t) => t.path === path);
  if (!existing) return;
  activeTabPath.value = path;
  if (existing.category !== 'text') return;

  try {
    const { content, contentHash } = await fetchFileContent(existing.contentUrl);
    if (contentHash === existing.baseHash) return; // unchanged — no-op

    if (!existing.dirty.value) {
      // Clean: silently refresh — this is the reported bug (switching tabs
      // away and back showed stale content even after the file changed).
      existing.view?.dispatch({
        changes: { from: 0, to: existing.view.state.doc.length, insert: content },
      });
      openTabs.value = openTabs.value.map((t) =>
        t.path === path
          ? {
              ...t,
              savedContent: content,
              baseHash: contentHash,
              conflict: null,
              deletedOnDisk: false,
            }
          : t,
      );
    } else {
      // Dirty: never touch the editor — surface the conflict banner instead.
      openTabs.value = openTabs.value.map((t) =>
        t.path === path
          ? { ...t, conflict: { currentHash: contentHash, onDiskContent: content } }
          : t,
      );
    }
  } catch (err) {
    if (err instanceof FileFetchError && err.status === 404) {
      if (!existing.dirty.value) {
        openTabs.value = openTabs.value.map((t) =>
          t.path === path ? { ...t, deletedOnDisk: true } : t,
        );
      } else {
        // '' is the "deleted" sentinel the banner/discardConflict check for.
        openTabs.value = openTabs.value.map((t) =>
          t.path === path ? { ...t, conflict: { currentHash: '', onDiskContent: '' } } : t,
        );
      }
    }
    // Any other fetch failure: leave the tab exactly as-is — matching the
    // existing no-live-updates posture rather than opening a second error
    // channel on top of the tab's own `error` field.
  }
}

export async function openFile(workspaceId: string, node: FileNode): Promise<void> {
  const existing = openTabs.value.find((t) => t.path === node.path);
  if (existing) {
    await activateTab(workspaceId, node.path);
    return;
  }

  const { path, content: contentUrl, category } = node;

  switch (category) {
    case 'unsupported': {
      // The tree already told us this file can't be previewed — no fetch
      // attempt at all.
      const tab: OpenTab = {
        path,
        contentUrl: contentUrl!,
        category: 'unsupported',
        view: null,
        savedContent: '',
        baseHash: '',
        dirty: signal(false),
        unsupported: true,
      };
      openTabs.value = [...openTabs.value, tab];
      activeTabPath.value = path;
      return;
    }
    case 'image':
    case 'audio':
    case 'video': {
      // No fetch — the media element's src performs the GET natively.
      const tab: OpenTab = {
        path,
        contentUrl: contentUrl!,
        category,
        view: null,
        savedContent: '',
        baseHash: '',
        dirty: signal(false),
      };
      openTabs.value = [...openTabs.value, tab];
      activeTabPath.value = path;
      return;
    }
    case 'text':
    default: {
      try {
        const { content, contentHash } = await fetchFileContent(contentUrl!);
        const tab: OpenTab = {
          path,
          contentUrl: contentUrl!,
          category: 'text',
          view: null,
          savedContent: content,
          baseHash: contentHash,
          dirty: signal(false),
        };
        openTabs.value = [...openTabs.value, tab];
        activeTabPath.value = path;
      } catch (err) {
        if (err instanceof FileFetchError && err.status === 422) {
          // The tree said 'text', but the real read disagrees (stale
          // classification) — same fallback as a genuinely unsupported file.
          const tab: OpenTab = {
            path,
            contentUrl: contentUrl!,
            category: 'text',
            view: null,
            savedContent: '',
            baseHash: '',
            dirty: signal(false),
            unsupported: true,
          };
          openTabs.value = [...openTabs.value, tab];
          activeTabPath.value = path;
          return;
        }

        const tab: OpenTab = {
          path,
          contentUrl: contentUrl!,
          category: 'text',
          view: null,
          savedContent: '',
          baseHash: '',
          dirty: signal(false),
          error: err instanceof Error ? err.message : 'Failed to open file',
        };
        openTabs.value = [...openTabs.value, tab];
        activeTabPath.value = path;
      }
    }
  }
}

export function setTabView(path: string, view: EditorView): void {
  openTabs.value = openTabs.value.map((t) => (t.path === path ? { ...t, view } : t));
}

export async function saveTab(workspaceId: string, path: string, force = false): Promise<void> {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab || !tab.view) return;

  const content = tab.view.state.doc.toString();
  try {
    const { contentHash } = await saveFile(tab.contentUrl, content, tab.baseHash, force);
    openTabs.value = openTabs.value.map((t) =>
      t.path === path
        ? {
            ...t,
            savedContent: content,
            baseHash: contentHash,
            error: undefined,
            conflict: null,
            deletedOnDisk: false,
          }
        : t,
    );
    tab.dirty.value = false;
    void loadFileTree(workspaceId, { force: true });
  } catch (err) {
    if (err instanceof SaveConflictError) {
      openTabs.value = openTabs.value.map((t) =>
        t.path === path
          ? { ...t, conflict: { currentHash: err.currentHash, onDiskContent: '' } }
          : t,
      );
      return;
    }
    openTabs.value = openTabs.value.map((t) =>
      t.path === path
        ? { ...t, error: err instanceof Error ? err.message : 'Failed to save file' }
        : t,
    );
  }
}

// The conflict banner's "Overwrite" action — same save, with the server-side
// hash check explicitly bypassed.
export function overwriteTab(workspaceId: string, path: string): void {
  void saveTab(workspaceId, path, true);
}

// The conflict banner's "Discard my edits" action — reloads whatever the
// reactivation check already fetched as the on-disk version (tab.conflict),
// distinct from discardTab() below, which reloads the tab's own last-saved
// content and has nothing to do with an on-disk conflict.
export function discardConflict(path: string): void {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab) return;

  if (tab.deletedOnDisk || tab.conflict?.currentHash === '') {
    // closeTabsUnderPath, not closeTab — "Discard my edits" is already the
    // user's explicit choice (clicked from the conflict banner), so this
    // must never re-prompt via closeTab's confirm() gate. It also happens
    // to do exactly the single-path close this needs, with no confirm.
    closeTabsUnderPath(path);
    return;
  }
  if (!tab.view || !tab.conflict) return;

  const onDiskContent = tab.conflict.onDiskContent;
  const currentHash = tab.conflict.currentHash;
  tab.view.dispatch({
    changes: { from: 0, to: tab.view.state.doc.length, insert: onDiskContent },
  });
  openTabs.value = openTabs.value.map((t) =>
    t.path === path
      ? { ...t, savedContent: onDiskContent, baseHash: currentHash, conflict: null }
      : t,
  );
  tab.dirty.value = false;
}

export function discardTab(path: string): void {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab || !tab.view) return;

  tab.view.dispatch({
    changes: { from: 0, to: tab.view.state.doc.length, insert: tab.savedContent },
  });
  tab.dirty.value = false;
}

export function closeTab(path: string): void {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab) return;

  if (tab.dirty.value && !confirm(`Discard unsaved changes to "${path}"?`)) return;

  tab.view?.destroy();
  openTabs.value = openTabs.value.filter((t) => t.path !== path);
  if (activeTabPath.value === path) {
    const remaining = openTabs.value;
    activeTabPath.value = remaining.length > 0 ? remaining[remaining.length - 1]!.path : null;
  }
}

// Used by deleteEntry() below: closes a path and everything nested under it
// (a directory delete can take several open tabs with it), with no confirm
// — deleting is itself the deliberate, final action, unlike closeTab()'s
// single-tab, confirm-gated close.
export function closeTabsUnderPath(pathPrefix: string): void {
  const toClose = openTabs.value.filter(
    (t) => t.path === pathPrefix || t.path.startsWith(`${pathPrefix}/`),
  );
  if (toClose.length === 0) return;

  for (const tab of toClose) tab.view?.destroy();
  const closingPaths = new Set(toClose.map((t) => t.path));
  openTabs.value = openTabs.value.filter((t) => !closingPaths.has(t.path));
  if (activeTabPath.value !== null && closingPaths.has(activeTabPath.value)) {
    const remaining = openTabs.value;
    activeTabPath.value = remaining.length > 0 ? remaining[remaining.length - 1]!.path : null;
  }
}

export async function uploadFiles(
  workspaceId: string,
  dir: string,
  files: FileList | File[],
): Promise<UploadResult> {
  const result = await uploadFilesApi(workspaceId, dir, files);
  if (result.ok) {
    void loadFileTree(workspaceId, { force: true });
  }
  return result;
}

export async function createDirectory(
  workspaceId: string,
  dir: string,
  name: string,
): Promise<CreateEntryResult> {
  const result = await createDirectoryApi(workspaceId, dir, name);
  if (result.ok) {
    expandFolder(dir);
    await loadFileTree(workspaceId, { force: true });
  }
  return result;
}

export async function createFile(
  workspaceId: string,
  dir: string,
  name: string,
): Promise<CreateEntryResult> {
  const result = await createFileApi(workspaceId, dir, name);
  if (result.ok) {
    expandFolder(dir);
    await loadFileTree(workspaceId, { force: true });
    // The create-file response doesn't carry a content URL (that's built
    // server-side from the tree walk, not this endpoint) — find the fresh
    // node in the just-reloaded tree instead of duplicating the URL-building
    // logic here.
    const node = fileTree.value ? findNode(fileTree.value.entries, result.path) : null;
    if (node) await openFile(workspaceId, node);
  }
  return result;
}

export async function deleteEntry(workspaceId: string, path: string): Promise<DeleteEntryResult> {
  const result = await deleteFileEntryApi(workspaceId, path);
  if (result.ok) {
    closeTabsUnderPath(path);
    await loadFileTree(workspaceId, { force: true });
  }
  return result;
}

// Dedupes propose_file_merge tool calls by toolCallId so revisiting a
// workspace chat's history (or an unrelated re-render) never re-applies a
// merge proposal that was already loaded into the editor once.
const _consumedMergeProposals = new Set<string>();

// Watches a workspace's chat thread for a completed propose_file_merge tool
// call and loads its mergedContent into the matching open tab as a
// reviewable draft — never written to disk directly (see
// docs/superpowers/specs/2026-10-12-workspace-file-explorer-sync-and-
// delete-design.md §2). Returns the effect's disposer for the caller's
// cleanup.
export function applyAgentResolveProposals(thread: ThreadInstance): () => void {
  return effect(() => {
    for (const m of thread.messages.value) {
      if (m.kind !== 'tool_call' || m.toolName !== 'propose_file_merge' || m.status !== 'done') {
        continue;
      }
      if (_consumedMergeProposals.has(m.toolCallId)) continue;

      const { path, mergedContent } = m.inputs as { path?: unknown; mergedContent?: unknown };
      if (typeof path !== 'string' || typeof mergedContent !== 'string') continue;

      const tab = openTabs.value.find((t) => t.path === path);
      if (!tab) continue; // tab not open — nothing to load into, no-op either way; not
      // marked consumed, so it's still picked up if the tab opens later.

      _consumedMergeProposals.add(m.toolCallId);

      // savedContent is authoritative — it's what CodeEditor's
      // initialContent reads on every (re)mount, so it's what survives
      // "Agent Resolve" switching the user to the Chat tab and back, which
      // fully unmounts (and destroys) this tab's live CodeMirror view in
      // the meantime. Dispatching to the view too, when one happens to
      // still be alive, gives instant visual feedback without waiting for
      // a remount; the try/catch is only for the case where tab.view is a
      // stale reference to an already-destroyed view (code-editor.tsx's
      // unmount cleanup calls view.destroy() but never clears tab.view
      // itself back to null).
      try {
        tab.view?.dispatch({
          changes: { from: 0, to: tab.view.state.doc.length, insert: mergedContent },
        });
      } catch {
        // Destroyed view — savedContent below is what actually matters.
      }
      tab.dirty.value = true;
      openTabs.value = openTabs.value.map((t) =>
        t.path === path ? { ...t, savedContent: mergedContent } : t,
      );

      // Re-fetch rather than reuse tab.conflict.currentHash, which may be
      // stale by the time the agent actually responds.
      void fetchFileContent(tab.contentUrl).then(({ contentHash }) => {
        openTabs.value = openTabs.value.map((t) =>
          t.path === path ? { ...t, baseHash: contentHash, conflict: null } : t,
        );
      });
    }
  });
}

// Test-only: signals are module-level singletons, so every describe block
// touching this hook must reset state in afterEach (same reason
// workspace-overview.test.tsx resets workspaces/projects).
export function resetWorkspaceFilesState(): void {
  fileTree.value = null;
  fileTreeLoading.value = false;
  fileTreeError.value = null;
  expandedFolders.value = new Set();
  openTabs.value = [];
  activeTabPath.value = null;
  _consumedMergeProposals.clear();
}
