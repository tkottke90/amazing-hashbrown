import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

import { FileTree } from '@/pages/workspaces/file-tree';
import { ThemeProvider } from '@/hooks/use-theme';
import {
  fileTree,
  fileTreeError,
  expandedFolders,
  selectedFolderPath,
} from '@/hooks/use-workspace-files';
import type { FileTreeResponse } from '@/services/workspace-files-api';

jest.mock('@/hooks/use-workspace-files', () => ({
  ...jest.requireActual('@/hooks/use-workspace-files'),
  uploadFiles: jest.fn(),
  createFile: jest.fn(),
  createDirectory: jest.fn(),
}));

import { uploadFiles, createFile, createDirectory } from '@/hooks/use-workspace-files';

const uploadFilesMock = uploadFiles as jest.MockedFunction<typeof uploadFiles>;
const createFileMock = createFile as jest.MockedFunction<typeof createFile>;
const createDirectoryMock = createDirectory as jest.MockedFunction<typeof createDirectory>;

function renderTree() {
  return render(
    <ThemeProvider>
      <FileTree workspaceId="ws-1" />
    </ThemeProvider>,
  );
}

const treeWithFolder: FileTreeResponse = {
  branch: 'main',
  entries: [
    {
      name: 'src',
      path: 'src',
      type: 'dir',
      children: [
        { name: 'index.ts', path: 'src/index.ts', type: 'file', gitStatus: 'M' },
        { name: 'new-file.ts', path: 'src/new-file.ts', type: 'file', gitStatus: 'A' },
      ],
    },
    { name: 'README.md', path: 'README.md', type: 'file' },
    {
      name: 'archive.zip',
      path: 'archive.zip',
      type: 'file',
      category: 'unsupported',
      oversize: false,
    },
    { name: 'huge.txt', path: 'huge.txt', type: 'file', category: 'text', oversize: true },
  ],
};

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-testid="file-tree-row"]') as HTMLElement;
}

describe('FileTree', () => {
  afterEach(() => {
    fileTree.value = null;
    fileTreeError.value = null;
    expandedFolders.value = new Set();
    selectedFolderPath.value = null;
    jest.clearAllMocks();
  });

  it('shows the git branch in the header when present', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    expect(screen.getByText('git · main')).toBeInTheDocument();
  });

  it('renders top-level entries and hides folder children until expanded', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('expands a folder via its chevron, and collapses again on a second chevron click', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    const chevron = within(rowFor('src')).getByTestId('file-tree-chevron');
    fireEvent.click(chevron);
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('new-file.ts')).toBeInTheDocument();

    fireEvent.click(chevron);
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('selects a folder on click (name/icon area), without expanding it', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    fireEvent.click(screen.getByText('src'));
    expect(selectedFolderPath.value).toBe('src');
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument(); // still collapsed
    expect(rowFor('src')).toHaveClass('bg-muted');
  });

  it('clicking an already-selected folder deselects it back to root', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    fireEvent.click(screen.getByText('src'));
    expect(selectedFolderPath.value).toBe('src');

    fireEvent.click(screen.getByText('src'));
    expect(selectedFolderPath.value).toBeNull();
    expect(rowFor('src')).not.toHaveClass('bg-muted');
  });

  it("clicking the chevron doesn't change the current folder selection", () => {
    fileTree.value = treeWithFolder;
    renderTree();

    fireEvent.click(screen.getByText('src'));
    expect(selectedFolderPath.value).toBe('src');

    fireEvent.click(within(rowFor('src')).getByTestId('file-tree-chevron'));
    expect(selectedFolderPath.value).toBe('src'); // unaffected by the expand toggle
    expect(screen.getByText('index.ts')).toBeInTheDocument(); // did expand
  });

  it('clicking a file opens it and clears any folder selection', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    fireEvent.click(screen.getByText('src'));
    expect(selectedFolderPath.value).toBe('src');

    fireEvent.click(screen.getByText('README.md'));
    expect(selectedFolderPath.value).toBeNull();
  });

  it('renders M/A git-status badges on files that have a gitStatus', () => {
    fileTree.value = treeWithFolder;
    expandedFolders.value = new Set(['src']);
    renderTree();

    expect(rowFor('index.ts')).toHaveTextContent('M');
    expect(rowFor('new-file.ts')).toHaveTextContent('A');
    expect(rowFor('README.md')).not.toHaveTextContent(/[MA]$/);
  });

  it('renders the unsupported badge with the expected title', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    const badge = screen.getByTestId('file-tree-unsupported');
    expect(badge).toHaveAttribute('title', "Can't preview this file type");
    expect(rowFor('archive.zip')).toContainElement(badge);
  });

  it('renders the oversize badge with the expected title', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    const badge = screen.getByTestId('file-tree-oversize');
    expect(badge).toHaveAttribute('title', 'File is too large to open');
    expect(rowFor('huge.txt')).toContainElement(badge);
  });

  it('renders neither badge on a plain text file', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    const readmeRow = rowFor('README.md');
    expect(readmeRow.querySelector('[data-testid="file-tree-unsupported"]')).toBeNull();
    expect(readmeRow.querySelector('[data-testid="file-tree-oversize"]')).toBeNull();
  });

  it('shows an error state instead of the tree when fileTreeError is set', () => {
    fileTree.value = treeWithFolder;
    fileTreeError.value = 'Workspace directory is missing or unreadable.';
    renderTree();

    expect(screen.getByText('Workspace directory is missing or unreadable.')).toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
  });

  it('renders no branch text when the workspace has no git enabled', () => {
    fileTree.value = { branch: null, entries: [] };
    renderTree();

    expect(screen.queryByText(/^git ·/)).not.toBeInTheDocument();
  });

  describe('folder action icons', () => {
    it('always renders the 3 action icons in the header, targeting root', () => {
      fileTree.value = treeWithFolder;
      renderTree();

      const header = screen.getByTestId('file-tree-header');
      expect(within(header).getByTestId('folder-action-upload')).toBeInTheDocument();
      expect(within(header).getByTestId('folder-action-new-file')).toBeInTheDocument();
      expect(within(header).getByTestId('folder-action-new-folder')).toBeInTheDocument();
    });

    it('does not render action icons on an unselected folder row', () => {
      fileTree.value = treeWithFolder;
      renderTree();

      expect(rowFor('src').querySelector('[data-testid="folder-action-upload"]')).toBeNull();
    });

    it('renders action icons on the selected folder row only', () => {
      fileTree.value = treeWithFolder;
      renderTree();

      fireEvent.click(screen.getByText('src'));
      expect(within(rowFor('src')).getByTestId('folder-action-upload')).toBeInTheDocument();
      expect(within(rowFor('src')).getByTestId('folder-action-new-file')).toBeInTheDocument();
      expect(within(rowFor('src')).getByTestId('folder-action-new-folder')).toBeInTheDocument();
    });

    it('clicking the upload icon opens the shared file picker, and selecting files uploads to that folder', async () => {
      uploadFilesMock.mockResolvedValue({ ok: true, created: ['a.txt'] });
      fileTree.value = treeWithFolder;
      renderTree();

      fireEvent.click(screen.getByText('src'));
      const uploadIcon = within(rowFor('src')).getByTestId('folder-action-upload');
      const input = screen.getByTestId('file-upload-input') as HTMLInputElement;
      const clickSpy = jest.spyOn(input, 'click');

      fireEvent.click(uploadIcon);
      expect(clickSpy).toHaveBeenCalled();

      const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      fireEvent.change(input);

      await waitFor(() =>
        expect(uploadFilesMock).toHaveBeenCalledWith('ws-1', 'src', [file]),
      );
    });

    it('shows an inline error when an upload is rejected', async () => {
      uploadFilesMock.mockResolvedValue({
        ok: false,
        error: 'Upload rejected',
        conflicts: ['a.txt'],
      });
      fileTree.value = treeWithFolder;
      renderTree();

      const input = screen.getByTestId('file-upload-input') as HTMLInputElement;
      const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      fireEvent.change(input);

      await waitFor(() => expect(screen.getByTestId('upload-error')).toBeInTheDocument());
      expect(screen.getByTestId('upload-error')).toHaveTextContent('Upload rejected');
      expect(screen.getByTestId('upload-error')).toHaveTextContent('a.txt');
      // The tree itself must stay visible/interactable alongside the error.
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    it('submitting the header "New file" form calls createFile with the root dir', async () => {
      createFileMock.mockResolvedValue({ ok: true, path: 'new.txt' });
      fileTree.value = treeWithFolder;
      renderTree();

      const header = screen.getByTestId('file-tree-header');
      const input = within(header).getByPlaceholderText('File name (e.g. notes.txt)');
      fireEvent.input(input, { target: { value: 'new.txt' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => expect(createFileMock).toHaveBeenCalledWith('ws-1', '', 'new.txt'));
    });

    it('submitting the selected row\'s "New folder" form calls createDirectory with that folder', async () => {
      createDirectoryMock.mockResolvedValue({ ok: true, path: 'src/child' });
      fileTree.value = treeWithFolder;
      renderTree();

      fireEvent.click(screen.getByText('src'));
      const row = rowFor('src');
      const input = within(row).getByPlaceholderText('Folder name');
      fireEvent.input(input, { target: { value: 'child' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() =>
        expect(createDirectoryMock).toHaveBeenCalledWith('ws-1', 'src', 'child'),
      );
    });
  });
});
