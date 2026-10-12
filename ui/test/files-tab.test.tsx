import { signal, type Signal } from '@preact/signals';
import { render, screen, within, fireEvent } from '@testing-library/preact';

jest.mock('@/services/workspace-files-api', () => {
  const actual = jest.requireActual('@/services/workspace-files-api');
  return {
    ...actual,
    fetchFileTree: jest.fn().mockResolvedValue({ branch: null, entries: [] }),
    fetchFileContent: jest.fn(),
    saveFile: jest.fn(),
  };
});

const mockUseThreadInstance = jest.fn();
jest.mock('@/hooks/use-thread', () => ({
  useThreadInstance: (...args: unknown[]) => mockUseThreadInstance(...args),
}));

import { FilesTab } from '@/pages/workspaces/files-tab';
import { ThemeProvider } from '@/hooks/use-theme';
import type { ThreadInstance } from '@/hooks/use-thread';
import {
  openTabs,
  activeTabPath,
  resetWorkspaceFilesState,
  type OpenTab,
} from '@/hooks/use-workspace-files';
import { mediaMuted } from '@/hooks/use-media-mute';

function stubThreadInstance(overrides: Partial<ThreadInstance> = {}): ThreadInstance {
  return {
    messages: signal([]),
    displayMessages: signal([]),
    isStreaming: signal(false),
    pendingHitlId: signal(null),
    activeThreadModel: signal(null),
    modelHydrated: signal(true),
    isSummarizing: signal(false),
    summaryPath: signal(null),
    isWaitingForProvider: signal(false),
    waitingProviderName: signal(null),
    threadType: signal(null),
    taskRun: signal(null),
    backgroundTurnActive: signal(false),
    markBackgroundTurn: jest.fn(),
    setThreadModel: jest.fn(),
    hydrate: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    submitHitlAnswer: jest.fn().mockResolvedValue(undefined),
    retryTurn: jest.fn().mockResolvedValue(undefined),
    stopGeneration: jest.fn(),
    ...overrides,
  };
}

// jest.setup.ts stubs matchMedia to never match by default, which would put
// these desktop-split-pane assertions on the mobile single-pane branch
// instead — force desktop for this file's existing coverage, same as
// ui/test/workspace-overview.test.tsx. The dedicated mobile describe block
// below overrides this locally.
function mockDesktopViewport(matches: boolean) {
  return jest.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        matches,
        media,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }) as unknown as MediaQueryList,
  );
}

beforeAll(() => {
  mockDesktopViewport(true);
});

afterAll(() => {
  jest.restoreAllMocks();
});

function makeTab(path: string, opts: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    contentUrl: `/api/v1/workspaces/ws-1/files/${path}/content`,
    category: 'text',
    view: null,
    savedContent: 'content',
    baseHash: 'base-hash',
    dirty: signal(false),
    ...opts,
  };
}

function renderFilesTab(overrides: { uploadRequest?: Signal<number>; threadId?: string } = {}) {
  return render(
    <ThemeProvider>
      <FilesTab
        workspaceId="ws-1"
        git={false}
        uploadRequest={overrides.uploadRequest}
        threadId={overrides.threadId}
        onGoToChat={jest.fn()}
      />
    </ThemeProvider>,
  );
}

describe('FilesTab', () => {
  afterEach(() => {
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('renders a tab bar entry for each open tab', () => {
    const tabA = makeTab('a.ts');
    const tabB = makeTab('src/b.ts');
    openTabs.value = [tabA, tabB];
    activeTabPath.value = 'a.ts';

    renderFilesTab();

    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
  });

  it('shows the unsaved-dot only on the tab whose dirty signal is true', () => {
    const tabA = makeTab('a.ts');
    const tabB = makeTab('b.ts');
    tabB.dirty.value = true;
    openTabs.value = [tabA, tabB];
    activeTabPath.value = 'a.ts';

    renderFilesTab();

    const aButton = screen.getByText('a.ts').closest('button')!;
    const bButton = screen.getByText('b.ts').closest('button')!;

    expect(within(aButton).queryByTestId('tab-unsaved-dot')).not.toBeInTheDocument();
    expect(within(bButton).getByTestId('tab-unsaved-dot')).toBeInTheDocument();
  });

  it('shows "Can\'t display this file" for a tab marked unsupported', () => {
    const tab = makeTab('image.bin', { unsupported: true });
    openTabs.value = [tab];
    activeTabPath.value = 'image.bin';

    renderFilesTab();

    expect(screen.getByText("Can't display this file.")).toBeInTheDocument();
  });

  it('shows a placeholder when no tabs are open', () => {
    renderFilesTab();

    expect(screen.getByText('Select a file to view its contents.')).toBeInTheDocument();
  });

  describe('closing a dirty tab', () => {
    const originalConfirm = global.confirm;

    afterEach(() => {
      global.confirm = originalConfirm;
    });

    it('prompts via window.confirm before closing, and closes when accepted', () => {
      global.confirm = jest.fn(() => true);
      const tab = makeTab('a.ts');
      tab.dirty.value = true;
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      screen.getByLabelText('Close a.ts').click();

      expect(global.confirm).toHaveBeenCalled();
      expect(openTabs.value).toHaveLength(0);
    });

    it('keeps the tab open when the confirm prompt is dismissed', () => {
      global.confirm = jest.fn(() => false);
      const tab = makeTab('a.ts');
      tab.dirty.value = true;
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      screen.getByLabelText('Close a.ts').click();

      expect(global.confirm).toHaveBeenCalled();
      expect(openTabs.value).toHaveLength(1);
    });
  });

  describe('EditorPanel media rendering', () => {
    it('renders an <img> for an image tab', () => {
      const tab = makeTab('photo.png', { category: 'image' });
      openTabs.value = [tab];
      activeTabPath.value = 'photo.png';

      renderFilesTab();

      const img = screen.getByTestId('file-image');
      expect(img).toHaveAttribute('src', tab.contentUrl);
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
    });

    it('renders an <audio> element for an audio tab', () => {
      const tab = makeTab('song.mp3', { category: 'audio' });
      openTabs.value = [tab];
      activeTabPath.value = 'song.mp3';

      renderFilesTab();

      expect(screen.getByTestId('file-audio')).toHaveAttribute('src', tab.contentUrl);
    });

    it('renders a <video> element for a video tab', () => {
      const tab = makeTab('clip.mp4', { category: 'video' });
      openTabs.value = [tab];
      activeTabPath.value = 'clip.mp4';

      renderFilesTab();

      expect(screen.getByTestId('file-video')).toHaveAttribute('src', tab.contentUrl);
    });

    it('still renders the CodeMirror Save/Discard row for a text tab', () => {
      const tab = makeTab('a.ts', { category: 'text' });
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Discard')).toBeInTheDocument();
    });
  });

  describe('EditorPanel conflict banner and deleted-on-disk state', () => {
    it('shows "This file was deleted on disk" with a Close tab button for a deletedOnDisk tab', () => {
      const tab = makeTab('a.ts', { deletedOnDisk: true });
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      expect(screen.getByTestId('file-deleted-on-disk')).toBeInTheDocument();
      expect(screen.queryByText('Save')).not.toBeInTheDocument();

      screen.getByText('Close tab').click();
      expect(openTabs.value).toHaveLength(0);
    });

    it('renders Overwrite/Discard/Agent Resolve for a normal (not-deleted) conflict', () => {
      const tab = makeTab('a.ts', {
        conflict: { currentHash: 'disk-hash', onDiskContent: 'on-disk' },
      });
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      expect(screen.getByTestId('file-conflict-banner')).toBeInTheDocument();
      expect(screen.getByText('Overwrite')).toBeInTheDocument();
      expect(screen.getByText('Discard my edits')).toBeInTheDocument();
      expect(screen.getByText('Agent Resolve')).toBeInTheDocument();
    });

    it('hides Overwrite and Agent Resolve for the deleted-on-disk conflict sentinel', () => {
      const tab = makeTab('a.ts', { conflict: { currentHash: '', onDiskContent: '' } });
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      expect(screen.getByTestId('file-conflict-banner')).toBeInTheDocument();
      expect(screen.queryByText('Overwrite')).not.toBeInTheDocument();
      expect(screen.queryByText('Agent Resolve')).not.toBeInTheDocument();
      expect(screen.getByText('Discard my edits')).toBeInTheDocument();
    });

    it('clicking Agent Resolve switches to chat and sends a composed path/draft/on-disk message', () => {
      const thread = stubThreadInstance();
      mockUseThreadInstance.mockReturnValue(thread);
      // No fake view here — CodeEditor mounts a real CodeMirror instance on
      // render and overwrites tab.view via setTabView, seeded from
      // savedContent (see code-editor.tsx's mount-effect-keyed-only-on-
      // [path] comment), so savedContent is what actually reaches the
      // editor's document and is what handleAgentResolve reads back out.
      const tab = makeTab('a.ts', {
        savedContent: 'my draft',
        conflict: { currentHash: 'disk-hash', onDiskContent: 'on-disk content' },
      });
      openTabs.value = [tab];
      activeTabPath.value = 'a.ts';
      const onGoToChat = jest.fn();

      render(
        <ThemeProvider>
          <FilesTab workspaceId="ws-1" git={false} threadId="thread-1" onGoToChat={onGoToChat} />
        </ThemeProvider>,
      );

      screen.getByText('Agent Resolve').click();

      expect(onGoToChat).toHaveBeenCalled();
      expect(thread.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('/resolve-file-conflict a.ts'),
      );
      const sentMessage = (thread.sendMessage as jest.Mock).mock.calls[0][0] as string;
      expect(sentMessage).toContain('my draft');
      expect(sentMessage).toContain('on-disk content');
    });
  });

  describe('EditorPanel media mute toggle', () => {
    afterEach(() => {
      mediaMuted.value = false;
      localStorage.clear();
    });

    it('is muted when the mute preference is on, even for the active tab', () => {
      mediaMuted.value = true;
      const tab = makeTab('clip.mp4', { category: 'video' });
      openTabs.value = [tab];
      activeTabPath.value = 'clip.mp4';

      renderFilesTab();

      expect(screen.getByTestId('file-video')).toHaveProperty('muted', true);
    });

    it('is muted when the tab is not active, even with the preference off', () => {
      mediaMuted.value = false;
      const activeTab = makeTab('a.ts', { category: 'text' });
      const videoTab = makeTab('clip.mp4', { category: 'video' });
      openTabs.value = [activeTab, videoTab];
      activeTabPath.value = 'a.ts';

      renderFilesTab();

      expect(screen.getByTestId('file-video')).toHaveProperty('muted', true);
    });

    it('is unmuted only when the preference is off and the tab is active', () => {
      mediaMuted.value = false;
      const tab = makeTab('clip.mp4', { category: 'video' });
      openTabs.value = [tab];
      activeTabPath.value = 'clip.mp4';

      renderFilesTab();

      expect(screen.getByTestId('file-video')).toHaveProperty('muted', false);
    });

    it('clicking the mute toggle flips mediaMuted', () => {
      mediaMuted.value = false;
      const tab = makeTab('clip.mp4', { category: 'video' });
      openTabs.value = [tab];
      activeTabPath.value = 'clip.mp4';

      renderFilesTab();

      screen.getByTestId('media-mute-toggle').click();
      expect(mediaMuted.value).toBe(true);
    });
  });
});

describe('FilesTab mobile (< lg)', () => {
  let matchMediaSpy: ReturnType<typeof mockDesktopViewport>;

  beforeEach(() => {
    matchMediaSpy = mockDesktopViewport(false);
  });

  afterEach(() => {
    matchMediaSpy.mockRestore();
    resetWorkspaceFilesState();
    jest.clearAllMocks();
  });

  it('shows the file tree, not the desktop placeholder, when no tab is active [unit]', () => {
    renderFilesTab();

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    expect(screen.queryByText('Select a file to view its contents.')).not.toBeInTheDocument();
  });

  it('shows the active tab full width with a back arrow instead of a tab bar [unit]', () => {
    const tab = makeTab('a.ts');
    openTabs.value = [tab];
    activeTabPath.value = 'a.ts';

    renderFilesTab();

    expect(screen.getByTestId('files-mobile-back')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab')).not.toBeInTheDocument();
  });

  it('returns to the tree when the back arrow is tapped, without closing the tab [unit]', () => {
    const tab = makeTab('a.ts');
    openTabs.value = [tab];
    activeTabPath.value = 'a.ts';

    renderFilesTab();
    fireEvent.click(screen.getByTestId('files-mobile-back'));

    expect(activeTabPath.value).toBeNull();
    expect(openTabs.value).toHaveLength(1);
    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('preserves another open tab’s editor pane across a drill-down/back round trip [unit]', () => {
    const tabA = makeTab('a.ts');
    const tabB = makeTab('b.ts');
    openTabs.value = [tabA, tabB];
    activeTabPath.value = 'a.ts';

    renderFilesTab();
    screen.getByTestId('files-mobile-back').click();
    activeTabPath.value = 'b.ts';

    expect(openTabs.value.map((t) => t.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('hides the file tree’s own upload icon, since the bottom app bar owns upload on mobile [unit]', () => {
    renderFilesTab();

    expect(screen.queryByTestId('folder-action-upload')).not.toBeInTheDocument();
  });
});
