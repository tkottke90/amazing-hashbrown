import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

jest.mock('@/services/workspace-git-api', () => ({
  fetchGitStatus: jest.fn(),
  fetchGitBranches: jest.fn(),
  gitSync: jest.fn(),
  gitPush: jest.fn(),
  gitCheckout: jest.fn(),
  gitCreateBranch: jest.fn(),
}));

jest.mock('@/hooks/use-workspace-files', () => ({
  loadFileTree: jest.fn(),
}));

import { GitControls } from '@/pages/workspaces/git-controls';
import * as gitApi from '@/services/workspace-git-api';
import * as filesHooks from '@/hooks/use-workspace-files';
import type { GitStatus, GitBranches } from '@/services/workspace-git-api';

const mockFetchGitStatus = gitApi.fetchGitStatus as jest.MockedFunction<typeof gitApi.fetchGitStatus>;
const mockFetchGitBranches = gitApi.fetchGitBranches as jest.MockedFunction<
  typeof gitApi.fetchGitBranches
>;
const mockGitSync = gitApi.gitSync as jest.MockedFunction<typeof gitApi.gitSync>;
const mockGitPush = gitApi.gitPush as jest.MockedFunction<typeof gitApi.gitPush>;
const mockGitCheckout = gitApi.gitCheckout as jest.MockedFunction<typeof gitApi.gitCheckout>;
const mockGitCreateBranch = gitApi.gitCreateBranch as jest.MockedFunction<
  typeof gitApi.gitCreateBranch
>;
const mockLoadFileTree = filesHooks.loadFileTree as jest.MockedFunction<typeof filesHooks.loadFileTree>;

const BASE_STATUS: GitStatus = {
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  hasRemote: true,
  dirty: false,
};

const BASE_BRANCHES: GitBranches = { local: ['main', 'feature-x'], remote: ['origin/main'] };

describe('GitControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchGitStatus.mockResolvedValue(BASE_STATUS);
    mockFetchGitBranches.mockResolvedValue(BASE_BRANCHES);
  });

  it('renders nothing when git is false, and never fetches status', () => {
    const { container } = render(<GitControls workspaceId="ws-1" git={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockFetchGitStatus).not.toHaveBeenCalled();
    expect(mockFetchGitBranches).not.toHaveBeenCalled();
  });

  it('loads and displays the current branch when git is true', async () => {
    render(<GitControls workspaceId="ws-1" git={true} />);
    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(mockFetchGitStatus).toHaveBeenCalledWith('ws-1');
    expect(mockFetchGitBranches).toHaveBeenCalledWith('ws-1');
  });

  it('shows an ahead/behind badge only when there is a remote and a non-zero count', async () => {
    mockFetchGitStatus.mockResolvedValue({ ...BASE_STATUS, ahead: 2, behind: 1 });
    render(<GitControls workspaceId="ws-1" git={true} />);

    const badge = await screen.findByTestId('git-ahead-behind');
    expect(badge.textContent).toBe('↑2↓1');
  });

  it('does not show the ahead/behind badge when up to date', async () => {
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');
    expect(screen.queryByTestId('git-ahead-behind')).not.toBeInTheDocument();
  });

  it('calls gitSync on Sync click and refreshes the file tree', async () => {
    mockGitSync.mockResolvedValue(BASE_STATUS);
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    await waitFor(() => expect(mockGitSync).toHaveBeenCalledWith('ws-1'));
    await waitFor(() => expect(mockLoadFileTree).toHaveBeenCalledWith('ws-1', { force: true }));
  });

  it('shows the error message and does not refresh the file tree when Sync fails', async () => {
    mockGitSync.mockRejectedValue(new Error('fatal: could not read from remote'));
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    expect(await screen.findByTestId('git-controls-error')).toHaveTextContent(
      'fatal: could not read from remote',
    );
    expect(mockLoadFileTree).not.toHaveBeenCalled();
  });

  it('calls gitPush on Push click', async () => {
    mockGitPush.mockResolvedValue(BASE_STATUS);
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    await waitFor(() => expect(mockGitPush).toHaveBeenCalledWith('ws-1'));
  });

  it('switches branches via the branch selector', async () => {
    mockGitCheckout.mockResolvedValue({ ...BASE_STATUS, branch: 'feature-x' });
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');

    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('feature-x'));

    await waitFor(() => expect(mockGitCheckout).toHaveBeenCalledWith('ws-1', 'feature-x'));
  });

  it('creates a new branch from the "New branch" flow', async () => {
    mockGitCreateBranch.mockResolvedValue({ ...BASE_STATUS, branch: 'feature-y' });
    render(<GitControls workspaceId="ws-1" git={true} />);
    await screen.findByText('main');

    fireEvent.click(screen.getByRole('button', { name: /New branch/ }));
    fireEvent.input(screen.getByPlaceholderText('new-branch-name'), {
      target: { value: 'feature-y' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockGitCreateBranch).toHaveBeenCalledWith('ws-1', 'feature-y'));
  });
});
