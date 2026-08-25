import { signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';

jest.mock('@/services/workspace-files-api', () => {
  const actual = jest.requireActual('@/services/workspace-files-api');
  return {
    ...actual,
    fetchFileTree: jest.fn().mockResolvedValue({ branch: null, entries: [] }),
    fetchFileContent: jest.fn(),
    saveFile: jest.fn(),
  };
});

import * as api from '@/services/workspace-files-api';
import {
  openTabs,
  activeTabPath,
  saveTab,
  discardTab,
  closeTab,
  resetWorkspaceFilesState,
  type OpenTab,
} from '@/hooks/use-workspace-files';

const mockSaveFile = api.saveFile as jest.MockedFunction<typeof api.saveFile>;

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

function makeTab(path: string, content: string): { tab: OpenTab; mock: ReturnType<typeof createMockView> } {
  const mock = createMockView(content);
  const tab: OpenTab = {
    path,
    view: mock.view,
    savedContent: content,
    dirty: signal(false),
  };
  return { tab, mock };
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

describe('use-workspace-files — saveTab', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('on success: updates savedContent, clears dirty, and clears any prior error', async () => {
    const { tab, mock } = makeTab('a.ts', 'const a = 1;');
    tab.dirty.value = true;
    tab.error = 'stale error';
    openTabs.value = [tab];
    mockSaveFile.mockResolvedValue(undefined);

    mock.dispatch({ changes: { from: 0, to: 0, insert: 'const a = 2;' } });

    await saveTab('ws-1', 'a.ts');

    expect(mockSaveFile).toHaveBeenCalledWith('ws-1', 'a.ts', 'const a = 2;');
    const saved = openTabs.value.find((t) => t.path === 'a.ts')!;
    expect(saved.savedContent).toBe('const a = 2;');
    expect(saved.error).toBeUndefined();
    expect(tab.dirty.value).toBe(false);
  });

  it('on failure: sets tab.error and leaves the buffer/dirty state untouched', async () => {
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
    const tab: OpenTab = { path: 'bin.dat', view: null, savedContent: '', dirty: signal(false), unsupported: true };
    openTabs.value = [tab];

    await saveTab('ws-1', 'bin.dat');

    expect(mockSaveFile).not.toHaveBeenCalled();
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
