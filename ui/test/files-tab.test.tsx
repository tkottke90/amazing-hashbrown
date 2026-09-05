import { signal } from '@preact/signals';
import { render, screen, within } from '@testing-library/preact';

jest.mock('@/services/workspace-files-api', () => {
  const actual = jest.requireActual('@/services/workspace-files-api');
  return {
    ...actual,
    fetchFileTree: jest.fn().mockResolvedValue({ branch: null, entries: [] }),
    fetchFileContent: jest.fn(),
    saveFile: jest.fn(),
  };
});

import { FilesTab } from '@/pages/workspaces/files-tab';
import { ThemeProvider } from '@/hooks/use-theme';
import {
  openTabs,
  activeTabPath,
  resetWorkspaceFilesState,
  type OpenTab,
} from '@/hooks/use-workspace-files';
import { mediaMuted } from '@/hooks/use-media-mute';

function makeTab(path: string, opts: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    contentUrl: `/api/v1/workspaces/ws-1/files/${path}/content`,
    category: 'text',
    view: null,
    savedContent: 'content',
    dirty: signal(false),
    ...opts,
  };
}

function renderFilesTab() {
  return render(
    <ThemeProvider>
      <FilesTab workspaceId="ws-1" git={false} />
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
