import { signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';

jest.mock('@/services/workspace-files-api', () => {
  const actual = jest.requireActual('@/services/workspace-files-api');
  return {
    ...actual,
    fetchFileTree: jest.fn().mockResolvedValue({ branch: null, entries: [] }),
    fetchFileContent: jest.fn(),
    saveFile: jest.fn(),
    deleteFileEntry: jest.fn(),
    uploadFiles: jest.fn(),
    createDirectory: jest.fn(),
    createFile: jest.fn(),
  };
});

import * as api from '@/services/workspace-files-api';
import type { FileNode } from '@/services/workspace-files-api';
import {
  openTabs,
  activeTabPath,
  openFile,
  activateTab,
  saveTab,
  overwriteTab,
  discardConflict,
  discardTab,
  closeTab,
  closeTabsUnderPath,
  deleteEntry,
  applyAgentResolveProposals,
  expandedFolders,
  fileTree,
  uploadFiles,
  createDirectory,
  createFile,
  resetWorkspaceFilesState,
  type OpenTab,
} from '@/hooks/use-workspace-files';
import type { ThreadInstance } from '@/hooks/use-thread';

const mockSaveFile = api.saveFile as jest.MockedFunction<typeof api.saveFile>;
const mockFetchFileContent = api.fetchFileContent as jest.MockedFunction<
  typeof api.fetchFileContent
>;
const mockFetchFileTree = api.fetchFileTree as jest.MockedFunction<typeof api.fetchFileTree>;
const mockDeleteFileEntry = api.deleteFileEntry as jest.MockedFunction<typeof api.deleteFileEntry>;
const mockUploadFiles = api.uploadFiles as jest.MockedFunction<typeof api.uploadFiles>;
const mockCreateDirectory = api.createDirectory as jest.MockedFunction<typeof api.createDirectory>;
const mockCreateFile = api.createFile as jest.MockedFunction<typeof api.createFile>;

function makeNode(
  path: string,
  category: FileNode['category'],
  overrides: Partial<FileNode> = {},
): FileNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    category,
    oversize: false,
    content: `/api/v1/workspaces/ws-1/files/${path}/content`,
    ...overrides,
  };
}

// A minimal stand-in for EditorView shaped like the two members
// use-workspace-files.ts actually calls: state.doc.toString() and
// dispatch(...). No real CodeMirror is mounted here.
function createMockView(initialContent: string) {
  let doc = initialContent;
  const dispatch = jest.fn((tr: { changes: { from: number; to: number; insert: string } }) => {
    doc = tr.changes.insert;
  });
  const view = {
    get state() {
      return { doc: { toString: () => doc, length: doc.length } };
    },
    dispatch,
    destroy: jest.fn(),
  } as unknown as EditorView;
  return { view, dispatch, getDoc: () => doc };
}

function makeTab(
  path: string,
  content: string,
  baseHash = 'base-hash',
): { tab: OpenTab; mock: ReturnType<typeof createMockView> } {
  const mock = createMockView(content);
  const tab: OpenTab = {
    path,
    contentUrl: `/api/v1/workspaces/ws-1/files/${path}/content`,
    category: 'text',
    view: mock.view,
    savedContent: content,
    baseHash,
    dirty: signal(false),
  };
  return { tab, mock };
}

function makeThread(messages: unknown[]): ThreadInstance {
  return { messages: signal(messages) } as unknown as ThreadInstance;
}

describe('use-workspace-files — dirty signal semantics', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('flips true on an edit and stays true across further edits', () => {
    const { tab } = makeTab('a.ts', 'const a = 1;');
    openTabs.value = [tab];

    expect(tab.dirty.value).toBe(false);

    // Simulates what CodeEditor's updateListener does on tr.docChanged.
    tab.dirty.value = true;
    expect(tab.dirty.value).toBe(true);

    tab.dirty.value = true;
    expect(tab.dirty.value).toBe(true);
  });

  it('keeps dirty independent per tab — editing one tab does not flip another', () => {
    const { tab: tabA } = makeTab('a.ts', 'a');
    const { tab: tabB } = makeTab('b.ts', 'b');
    openTabs.value = [tabA, tabB];

    tabA.dirty.value = true;

    expect(tabA.dirty.value).toBe(true);
    expect(tabB.dirty.value).toBe(false);
  });
});

describe('use-workspace-files — openFile', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it("fetches content via node.content and pushes a 'text' tab, carrying baseHash", async () => {
    const node = makeNode('a.ts', 'text');
    mockFetchFileContent.mockResolvedValue({ content: 'const a = 1;', contentHash: 'hash-a' });

    await openFile('ws-1', node);

    expect(mockFetchFileContent).toHaveBeenCalledWith(node.content);
    const tab = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(tab.category).toBe('text');
    expect(tab.contentUrl).toBe(node.content);
    expect(tab.savedContent).toBe('const a = 1;');
    expect(tab.baseHash).toBe('hash-a');
    expect(tab.unsupported).toBeUndefined();
    expect(activeTabPath.value).toBe('a.ts');
  });

  it("opens an 'unsupported' node without calling fetchFileContent", async () => {
    const node = makeNode('archive.zip', 'unsupported');

    await openFile('ws-1', node);

    expect(mockFetchFileContent).not.toHaveBeenCalled();
    const tab = openTabs.value.find((t) => t.path === 'archive.zip')!;
    expect(tab.category).toBe('unsupported');
    expect(tab.unsupported).toBe(true);
    expect(tab.baseHash).toBe('');
  });

  it.each(['image', 'audio', 'video'] as const)(
    'opens a %s node without calling fetchFileContent, carrying contentUrl+category',
    async (category) => {
      const node = makeNode(`file.${category}`, category);

      await openFile('ws-1', node);

      expect(mockFetchFileContent).not.toHaveBeenCalled();
      const tab = openTabs.value.find((t) => t.path === node.path)!;
      expect(tab.category).toBe(category);
      expect(tab.contentUrl).toBe(node.content);
      expect(tab.unsupported).toBeUndefined();
    },
  );

  it('reactivating an existing open tab checks for staleness rather than skipping the fetch', async () => {
    const node = makeNode('a.ts', 'text');
    mockFetchFileContent.mockResolvedValue({ content: 'const a = 1;', contentHash: 'hash-a' });
    await openFile('ws-1', node);
    mockFetchFileContent.mockClear();

    await openFile('ws-1', node);

    expect(mockFetchFileContent).toHaveBeenCalledWith(node.content);
    expect(openTabs.value).toHaveLength(1);
    expect(activeTabPath.value).toBe('a.ts');
  });

  it("falls back to an unsupported tab (category stays 'text') on a 422 from a node classified 'text'", async () => {
    const node = makeNode('mislabeled.txt', 'text');
    mockFetchFileContent.mockRejectedValue(new api.FileFetchError('cannot be displayed', 422));

    await openFile('ws-1', node);

    const tab = openTabs.value.find((t) => t.path === 'mislabeled.txt')!;
    expect(tab.category).toBe('text');
    expect(tab.unsupported).toBe(true);
    expect(tab.error).toBeUndefined();
  });

  it('pushes an error tab (not unsupported) on a non-422 fetch failure', async () => {
    const node = makeNode('a.ts', 'text');
    mockFetchFileContent.mockRejectedValue(new Error('network error'));

    await openFile('ws-1', node);

    const tab = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(tab.unsupported).toBeUndefined();
    expect(tab.error).toBe('network error');
  });
});

describe('use-workspace-files — activateTab (reactivation/staleness check)', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('clean tab, unchanged hash: no-op — no dispatch, no state change', async () => {
    const { tab, mock } = makeTab('a.ts', 'content', 'hash-1');
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'content', contentHash: 'hash-1' });

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(openTabs.value[0]!.baseHash).toBe('hash-1');
  });

  it('clean tab, changed hash: silently refreshes the editor — the reported bug', async () => {
    const { tab, mock } = makeTab('a.ts', 'old content', 'hash-1');
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'new content', contentHash: 'hash-2' });

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 'old content'.length, insert: 'new content' },
    });
    const updated = openTabs.value[0]!;
    expect(updated.savedContent).toBe('new content');
    expect(updated.baseHash).toBe('hash-2');
    expect(updated.conflict).toBeFalsy();
  });

  it('clean tab, file deleted on disk: sets deletedOnDisk, no dispatch', async () => {
    const { tab, mock } = makeTab('a.ts', 'content', 'hash-1');
    openTabs.value = [tab];
    mockFetchFileContent.mockRejectedValue(new api.FileFetchError('not found', 404));

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(openTabs.value[0]!.deletedOnDisk).toBe(true);
  });

  it('dirty tab, unchanged hash: no conflict banner', async () => {
    const { tab, mock } = makeTab('a.ts', 'content', 'hash-1');
    tab.dirty.value = true;
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'content', contentHash: 'hash-1' });

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(openTabs.value[0]!.conflict).toBeFalsy();
  });

  it('dirty tab, changed hash: sets conflict and never touches the editor', async () => {
    const { tab, mock } = makeTab('a.ts', 'my edits', 'hash-1');
    tab.dirty.value = true;
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'on-disk content', contentHash: 'hash-2' });

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(openTabs.value[0]!.conflict).toEqual({
      currentHash: 'hash-2',
      onDiskContent: 'on-disk content',
    });
  });

  it('dirty tab, file deleted on disk: sets conflict with the empty-hash sentinel', async () => {
    const { tab, mock } = makeTab('a.ts', 'my edits', 'hash-1');
    tab.dirty.value = true;
    openTabs.value = [tab];
    mockFetchFileContent.mockRejectedValue(new api.FileFetchError('not found', 404));

    await activateTab('ws-1', 'a.ts');

    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(openTabs.value[0]!.conflict).toEqual({ currentHash: '', onDiskContent: '' });
  });

  it('is a no-op for a binary/unsupported tab — staleness is text-only', async () => {
    const tab: OpenTab = {
      path: 'photo.png',
      contentUrl: '/api/v1/workspaces/ws-1/files/photo.png/content',
      category: 'image',
      view: null,
      savedContent: '',
      baseHash: '',
      dirty: signal(false),
    };
    openTabs.value = [tab];

    await activateTab('ws-1', 'photo.png');

    expect(mockFetchFileContent).not.toHaveBeenCalled();
  });
});

describe('use-workspace-files — saveTab', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('on success: sends content+baseHash+force, updates savedContent/baseHash, clears dirty and error', async () => {
    const { tab, mock } = makeTab('a.ts', 'const a = 1;', 'hash-1');
    tab.dirty.value = true;
    tab.error = 'stale error';
    openTabs.value = [tab];
    mockSaveFile.mockResolvedValue({ contentHash: 'hash-2' });

    mock.dispatch({ changes: { from: 0, to: 0, insert: 'const a = 2;' } });

    await saveTab('ws-1', 'a.ts');

    expect(mockSaveFile).toHaveBeenCalledWith(tab.contentUrl, 'const a = 2;', 'hash-1', false);
    const saved = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(saved.savedContent).toBe('const a = 2;');
    expect(saved.baseHash).toBe('hash-2');
    expect(saved.error).toBeUndefined();
    expect(tab.dirty.value).toBe(false);
  });

  it('on a 409 conflict: sets tab.conflict and leaves dirty/view untouched', async () => {
    const { tab, mock } = makeTab('a.ts', 'const a = 1;', 'hash-1');
    tab.dirty.value = true;
    openTabs.value = [tab];
    mockSaveFile.mockRejectedValue(new api.SaveConflictError('conflict', 'server-hash'));

    await saveTab('ws-1', 'a.ts');

    const failed = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(failed.conflict).toEqual({ currentHash: 'server-hash', onDiskContent: '' });
    expect(tab.dirty.value).toBe(true);
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it('on a non-conflict failure: sets tab.error and leaves the buffer/dirty state untouched', async () => {
    const { tab } = makeTab('a.ts', 'const a = 1;');
    tab.dirty.value = true;
    openTabs.value = [tab];
    mockSaveFile.mockRejectedValue(new Error('EACCES: permission denied'));

    await saveTab('ws-1', 'a.ts');

    const failed = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(failed.error).toBe('EACCES: permission denied');
    expect(failed.savedContent).toBe('const a = 1;');
    expect(tab.dirty.value).toBe(true);
  });

  it('is a no-op for a tab with no live view (unsupported/error tabs)', async () => {
    const tab: OpenTab = {
      path: 'bin.dat',
      contentUrl: '/api/v1/workspaces/ws-1/files/bin.dat/content',
      category: 'unsupported',
      view: null,
      savedContent: '',
      baseHash: '',
      dirty: signal(false),
      unsupported: true,
    };
    openTabs.value = [tab];

    await saveTab('ws-1', 'bin.dat');

    expect(mockSaveFile).not.toHaveBeenCalled();
  });

  it('overwriteTab passes force:true, bypassing a hash mismatch server-side', async () => {
    const { tab } = makeTab('a.ts', 'content', 'stale-hash');
    openTabs.value = [tab];
    mockSaveFile.mockResolvedValue({ contentHash: 'new-hash' });

    overwriteTab('ws-1', 'a.ts');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveFile).toHaveBeenCalledWith(tab.contentUrl, 'content', 'stale-hash', true);
  });
});

describe('use-workspace-files — discardConflict', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('reloads the on-disk content from tab.conflict, clearing dirty/conflict and updating baseHash', () => {
    const { tab, mock } = makeTab('a.ts', 'my edits', 'hash-1');
    tab.dirty.value = true;
    tab.conflict = { currentHash: 'hash-2', onDiskContent: 'on-disk content' };
    openTabs.value = [tab];

    discardConflict('a.ts');

    expect(mock.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 'my edits'.length, insert: 'on-disk content' },
    });
    const updated = openTabs.value[0]!;
    expect(updated.savedContent).toBe('on-disk content');
    expect(updated.baseHash).toBe('hash-2');
    expect(updated.conflict).toBeNull();
    expect(tab.dirty.value).toBe(false);
  });

  it('closes the tab outright when the conflict is the "deleted on disk" sentinel', () => {
    const { tab } = makeTab('a.ts', 'my edits', 'hash-1');
    tab.dirty.value = true;
    tab.conflict = { currentHash: '', onDiskContent: '' };
    openTabs.value = [tab];
    activeTabPath.value = 'a.ts';

    discardConflict('a.ts');

    expect(openTabs.value).toHaveLength(0);
  });

  it('closes the tab outright for a clean deletedOnDisk tab', () => {
    const { tab } = makeTab('a.ts', 'content');
    tab.deletedOnDisk = true;
    openTabs.value = [tab];
    activeTabPath.value = 'a.ts';

    discardConflict('a.ts');

    expect(openTabs.value).toHaveLength(0);
  });
});

describe('use-workspace-files — discardTab', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('reverts the buffer to savedContent via a full-document dispatch and clears dirty', () => {
    const { tab, mock } = makeTab('a.ts', 'original');
    tab.dirty.value = true;
    openTabs.value = [tab];

    mock.dispatch({ changes: { from: 0, to: 0, insert: 'edited content' } });
    expect(mock.getDoc()).toBe('edited content');

    discardTab('a.ts');

    expect(mock.dispatch).toHaveBeenLastCalledWith({
      changes: { from: 0, to: 'edited content'.length, insert: 'original' },
    });
    expect(mock.getDoc()).toBe('original');
    expect(tab.dirty.value).toBe(false);
  });

  it('never calls saveFile — it does not touch disk', () => {
    const { tab } = makeTab('a.ts', 'original');
    openTabs.value = [tab];

    discardTab('a.ts');

    expect(mockSaveFile).not.toHaveBeenCalled();
  });
});

describe('use-workspace-files — closeTab', () => {
  const originalConfirm = global.confirm;

  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
    global.confirm = originalConfirm;
  });

  it('closes a clean tab without prompting', () => {
    const { tab } = makeTab('a.ts', 'content');
    openTabs.value = [tab];
    activeTabPath.value = 'a.ts';
    global.confirm = jest.fn(() => false);

    closeTab('a.ts');

    expect(global.confirm).not.toHaveBeenCalled();
    expect(openTabs.value).toHaveLength(0);
  });

  it('prompts via confirm() when the tab is dirty, and keeps the tab open on cancel', () => {
    const { tab } = makeTab('a.ts', 'content');
    tab.dirty.value = true;
    openTabs.value = [tab];
    global.confirm = jest.fn(() => false);

    closeTab('a.ts');

    expect(global.confirm).toHaveBeenCalled();
    expect(openTabs.value).toHaveLength(1);
  });

  it('closes a dirty tab when confirm() is accepted', () => {
    const { tab } = makeTab('a.ts', 'content');
    tab.dirty.value = true;
    openTabs.value = [tab];
    global.confirm = jest.fn(() => true);

    closeTab('a.ts');

    expect(openTabs.value).toHaveLength(0);
  });
});

describe('use-workspace-files — closeTabsUnderPath', () => {
  const originalConfirm = global.confirm;

  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
    global.confirm = originalConfirm;
  });

  it('closes the exact path and everything nested under it, without prompting even when dirty', () => {
    const { tab: root } = makeTab('sub/a.ts', 'a');
    const { tab: nested } = makeTab('sub/deep/b.ts', 'b');
    const { tab: unrelated } = makeTab('other.ts', 'c');
    nested.dirty.value = true;
    openTabs.value = [root, nested, unrelated];
    activeTabPath.value = 'sub/a.ts';
    global.confirm = jest.fn(() => false);

    closeTabsUnderPath('sub');

    expect(global.confirm).not.toHaveBeenCalled();
    expect(openTabs.value.map((t) => t.path)).toEqual(['other.ts']);
  });

  it('falls back the active tab when it was one of the closed ones', () => {
    const { tab: closing } = makeTab('sub/a.ts', 'a');
    const { tab: remaining } = makeTab('other.ts', 'b');
    openTabs.value = [closing, remaining];
    activeTabPath.value = 'sub/a.ts';

    closeTabsUnderPath('sub');

    expect(activeTabPath.value).toBe('other.ts');
  });

  it('is a no-op when nothing matches the prefix', () => {
    const { tab } = makeTab('other.ts', 'a');
    openTabs.value = [tab];

    closeTabsUnderPath('sub');

    expect(openTabs.value).toHaveLength(1);
  });
});

describe('use-workspace-files — deleteEntry', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('on success: closes tabs under the deleted path and reloads the tree', async () => {
    mockDeleteFileEntry.mockResolvedValue({ ok: true });
    mockFetchFileTree.mockResolvedValue({ branch: null, entries: [] });
    const { tab } = makeTab('sub/a.ts', 'content');
    openTabs.value = [tab];

    const result = await deleteEntry('ws-1', 'sub');

    expect(mockDeleteFileEntry).toHaveBeenCalledWith('ws-1', 'sub');
    expect(result).toEqual({ ok: true });
    expect(openTabs.value).toHaveLength(0);
    expect(mockFetchFileTree).toHaveBeenCalledWith('ws-1');
  });

  it('on failure: leaves tabs and the tree untouched', async () => {
    mockDeleteFileEntry.mockResolvedValue({ ok: false, error: 'not found' });
    const { tab } = makeTab('sub/a.ts', 'content');
    openTabs.value = [tab];

    const result = await deleteEntry('ws-1', 'sub');

    expect(result).toEqual({ ok: false, error: 'not found' });
    expect(openTabs.value).toHaveLength(1);
    expect(mockFetchFileTree).not.toHaveBeenCalled();
  });
});

describe('use-workspace-files — applyAgentResolveProposals', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('loads a completed propose_file_merge call into the matching open tab as a dirty draft', async () => {
    const { tab, mock } = makeTab('a.ts', 'my draft', 'hash-1');
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'merged', contentHash: 'hash-after-merge' });

    const thread = makeThread([
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'propose_file_merge',
        status: 'done',
        inputs: { path: 'a.ts', mergedContent: 'merged content', explanation: 'combined both' },
      },
    ]);
    const dispose = applyAgentResolveProposals(thread);
    await Promise.resolve();
    await Promise.resolve();

    expect(mock.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 'my draft'.length, insert: 'merged content' },
    });
    expect(tab.dirty.value).toBe(true);
    expect(openTabs.value[0]!.savedContent).toBe('merged content');
    expect(openTabs.value[0]!.baseHash).toBe('hash-after-merge');
    expect(openTabs.value[0]!.conflict).toBeNull();
    dispose();
  });

  it('updates savedContent (surviving a remount) even when the live view throws on dispatch', async () => {
    // Reproduces the Agent Resolve flow unmounting the tab's CodeMirror
    // view (switching to the Chat tab to watch, per the design) while the
    // proposal is still in flight — code-editor.tsx's unmount cleanup
    // destroys the view but never clears tab.view back to null, so a
    // stale/destroyed view is exactly what a real dispatch call hits here.
    const { tab } = makeTab('a.ts', 'my draft', 'hash-1');
    tab.view!.dispatch = jest.fn(() => {
      throw new Error('Calling Transaction.start on a destroyed editor');
    });
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: 'merged', contentHash: 'hash-after-merge' });

    const thread = makeThread([
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'propose_file_merge',
        status: 'done',
        inputs: { path: 'a.ts', mergedContent: 'merged content', explanation: 'combined both' },
      },
    ]);
    const dispose = applyAgentResolveProposals(thread);
    await Promise.resolve();
    await Promise.resolve();

    expect(tab.dirty.value).toBe(true);
    expect(openTabs.value[0]!.savedContent).toBe('merged content');
    dispose();
  });

  it('never re-applies the same toolCallId twice', async () => {
    const { tab, mock } = makeTab('a.ts', 'my draft');
    openTabs.value = [tab];
    mockFetchFileContent.mockResolvedValue({ content: '', contentHash: 'h' });

    const message = {
      kind: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'propose_file_merge',
      status: 'done',
      inputs: { path: 'a.ts', mergedContent: 'merged once', explanation: 'x' },
    };
    const thread = makeThread([message]);
    const dispose = applyAgentResolveProposals(thread);
    await Promise.resolve();
    await Promise.resolve();
    mock.dispatch.mockClear();

    thread.messages.value = [{ ...message }];
    await Promise.resolve();

    expect(mock.dispatch).not.toHaveBeenCalled();
    dispose();
  });

  it('is a no-op when no open tab matches the proposed path', async () => {
    const thread = makeThread([
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'propose_file_merge',
        status: 'done',
        inputs: { path: 'missing.ts', mergedContent: 'x', explanation: 'y' },
      },
    ]);

    const dispose = applyAgentResolveProposals(thread);
    await Promise.resolve();

    expect(openTabs.value).toHaveLength(0);
    dispose();
  });

  it('ignores a pending (not-yet-done) tool call', async () => {
    const { tab, mock } = makeTab('a.ts', 'my draft');
    openTabs.value = [tab];

    const thread = makeThread([
      {
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'propose_file_merge',
        status: 'pending',
        inputs: { path: 'a.ts', mergedContent: 'x', explanation: 'y' },
      },
    ]);
    const dispose = applyAgentResolveProposals(thread);
    await Promise.resolve();

    expect(mock.dispatch).not.toHaveBeenCalled();
    dispose();
  });
});

describe('use-workspace-files — uploadFiles', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('delegates to the api and reloads the tree on success', async () => {
    mockUploadFiles.mockResolvedValue({ ok: true, created: ['a.txt'] });
    mockFetchFileTree.mockResolvedValue({
      branch: null,
      entries: [{ name: 'a.txt', path: 'a.txt', type: 'file', category: 'text', content: 'u' }],
    });
    const files = [new File(['x'], 'a.txt')];

    const result = await uploadFiles('ws-1', 'sub', files);

    expect(mockUploadFiles).toHaveBeenCalledWith('ws-1', 'sub', files);
    expect(result).toEqual({ ok: true, created: ['a.txt'] });
    expect(mockFetchFileTree).toHaveBeenCalledWith('ws-1');
    expect(fileTree.value?.entries.map((n) => n.name)).toEqual(['a.txt']);
  });

  it('returns the failure without throwing, and does not reload the tree', async () => {
    mockUploadFiles.mockResolvedValue({
      ok: false,
      error: 'Upload rejected',
      conflicts: ['a.txt'],
    });

    const result = await uploadFiles('ws-1', '', [new File(['x'], 'a.txt')]);

    expect(result).toEqual({ ok: false, error: 'Upload rejected', conflicts: ['a.txt'] });
    expect(mockFetchFileTree).not.toHaveBeenCalled();
  });
});

describe('use-workspace-files — createDirectory', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('on success: expands the parent folder and reloads the tree', async () => {
    mockCreateDirectory.mockResolvedValue({ ok: true, path: 'sub/child' });
    mockFetchFileTree.mockResolvedValue({ branch: null, entries: [] });

    const result = await createDirectory('ws-1', 'sub', 'child');

    expect(mockCreateDirectory).toHaveBeenCalledWith('ws-1', 'sub', 'child');
    expect(result).toEqual({ ok: true, path: 'sub/child' });
    expect(expandedFolders.value.has('sub')).toBe(true);
    expect(mockFetchFileTree).toHaveBeenCalledWith('ws-1');
  });

  it('on failure: does not expand or reload', async () => {
    mockCreateDirectory.mockResolvedValue({ ok: false, error: 'already exists' });

    const result = await createDirectory('ws-1', 'sub', 'child');

    expect(result).toEqual({ ok: false, error: 'already exists' });
    expect(expandedFolders.value.has('sub')).toBe(false);
    expect(mockFetchFileTree).not.toHaveBeenCalled();
  });
});

describe('use-workspace-files — createFile', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('on success: reloads the tree, expands the parent, and opens the new file as an empty text tab', async () => {
    mockCreateFile.mockResolvedValue({ ok: true, path: 'sub/new.txt' });
    mockFetchFileTree.mockResolvedValue({
      branch: null,
      entries: [
        {
          name: 'sub',
          path: 'sub',
          type: 'dir',
          children: [
            {
              name: 'new.txt',
              path: 'sub/new.txt',
              type: 'file',
              category: 'text',
              content: '/api/v1/workspaces/ws-1/files/sub/new.txt/content',
            },
          ],
        },
      ],
    });
    mockFetchFileContent.mockResolvedValue({ content: '', contentHash: 'empty-hash' });

    const result = await createFile('ws-1', 'sub', 'new.txt');

    expect(mockCreateFile).toHaveBeenCalledWith('ws-1', 'sub', 'new.txt');
    expect(result).toEqual({ ok: true, path: 'sub/new.txt' });
    expect(expandedFolders.value.has('sub')).toBe(true);

    const tab = openTabs.value.find((t) => t.path === 'sub/new.txt');
    expect(tab).toBeDefined();
    expect(tab?.category).toBe('text');
  });

  it('on failure: does not touch the tree or open a tab', async () => {
    mockCreateFile.mockResolvedValue({ ok: false, error: 'already exists' });

    const result = await createFile('ws-1', '', 'existing.txt');

    expect(result).toEqual({ ok: false, error: 'already exists' });
    expect(mockFetchFileTree).not.toHaveBeenCalled();
    expect(openTabs.value).toHaveLength(0);
  });
});
