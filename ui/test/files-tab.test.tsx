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

import { FilesTab } from '@/components/files-tab';
import { ThemeProvider } from '@/hooks/use-theme';
import {
  openTabs,
  activeTabPath,
  resetWorkspaceFilesState,
  type OpenTab,
} from '@/hooks/use-workspace-files';

function makeTab(path: string, opts: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    view: null,
    savedContent: 'content',
    dirty: signal(false),
    ...opts,
  };
}

function renderFilesTab() {
  return render(
    <ThemeProvider>
      <FilesTab workspaceId="ws-1" />
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
});
