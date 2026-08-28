import { render, screen, fireEvent } from '@testing-library/preact';

import { FileTree } from '@/pages/workspaces/file-tree';
import { ThemeProvider } from '@/hooks/use-theme';
import { fileTree, fileTreeError, expandedFolders } from '@/hooks/use-workspace-files';
import type { FileTreeResponse } from '@/services/workspace-files-api';

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
  ],
};

describe('FileTree', () => {
  afterEach(() => {
    fileTree.value = null;
    fileTreeError.value = null;
    expandedFolders.value = new Set();
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

  it('expands a folder on click to reveal its children, and collapses again on a second click', () => {
    fileTree.value = treeWithFolder;
    renderTree();

    fireEvent.click(screen.getByText('src'));
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('new-file.ts')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src'));
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('renders M/A git-status badges on files that have a gitStatus', () => {
    fileTree.value = treeWithFolder;
    expandedFolders.value = new Set(['src']);
    renderTree();

    const modifiedRow = screen.getByText('index.ts').closest('button')!;
    expect(modifiedRow).toHaveTextContent('M');

    const addedRow = screen.getByText('new-file.ts').closest('button')!;
    expect(addedRow).toHaveTextContent('A');

    const readmeRow = screen.getByText('README.md').closest('button')!;
    expect(readmeRow).not.toHaveTextContent(/[MA]$/);
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
});
