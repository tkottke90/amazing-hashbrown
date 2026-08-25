import { signal, type Signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';

import {
  fetchFileTree,
  fetchFileContent,
  saveFile,
  FileFetchError,
  type FileTreeResponse,
} from '@/services/workspace-files-api';

export const fileTree = signal<FileTreeResponse | null>(null);
export const fileTreeLoading = signal(false);
export const fileTreeError = signal<string | null>(null);
export const expandedFolders = signal<Set<string>>(new Set());

export interface OpenTab {
  path: string;
  view: EditorView | null; // set once by CodeEditor's mount effect via setTabView
  savedContent: string;
  dirty: Signal<boolean>; // ONE signal per tab — never a shared array/object signal
  error?: string; // deleted-on-disk / fetch-failure case
  unsupported?: boolean; // binary/oversized case — no view, no content
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

export async function openFile(workspaceId: string, path: string): Promise<void> {
  const existing = openTabs.value.find((t) => t.path === path);
  if (existing) {
    activeTabPath.value = path;
    return;
  }

  try {
    const content = await fetchFileContent(workspaceId, path);
    const tab: OpenTab = {
      path,
      view: null,
      savedContent: content,
      dirty: signal(false),
    };
    openTabs.value = [...openTabs.value, tab];
    activeTabPath.value = path;
  } catch (err) {
    if (err instanceof FileFetchError && err.status === 422) {
      const tab: OpenTab = {
        path,
        view: null,
        savedContent: '',
        dirty: signal(false),
        unsupported: true,
      };
      openTabs.value = [...openTabs.value, tab];
      activeTabPath.value = path;
      return;
    }

    const tab: OpenTab = {
      path,
      view: null,
      savedContent: '',
      dirty: signal(false),
      error: err instanceof Error ? err.message : 'Failed to open file',
    };
    openTabs.value = [...openTabs.value, tab];
    activeTabPath.value = path;
  }
}

export function setTabView(path: string, view: EditorView): void {
  openTabs.value = openTabs.value.map((t) => (t.path === path ? { ...t, view } : t));
}

export async function saveTab(workspaceId: string, path: string): Promise<void> {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab || !tab.view) return;

  const content = tab.view.state.doc.toString();
  try {
    await saveFile(workspaceId, path, content);
    openTabs.value = openTabs.value.map((t) =>
      t.path === path ? { ...t, savedContent: content, error: undefined } : t,
    );
    tab.dirty.value = false;
    void loadFileTree(workspaceId, { force: true });
  } catch (err) {
    openTabs.value = openTabs.value.map((t) =>
      t.path === path
        ? { ...t, error: err instanceof Error ? err.message : 'Failed to save file' }
        : t,
    );
  }
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
}
