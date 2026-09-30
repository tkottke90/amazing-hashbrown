import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

import { WorkspaceSheet } from '@/pages/workspaces/workspace.sheet';
import { tasks } from '@/hooks/use-tasks';
import { boardTask } from './fixtures/board-task';

function setLocationHash(hash: string) {
  window.location.hash = hash;
}

describe('WorkspaceSheet', () => {
  afterEach(() => {
    tasks.value = [];
    setLocationHash('');
    cleanup();
  });

  it('renders all four tabs as links to their hash [unit]', () => {
    render(<WorkspaceSheet workspaceId="ws-1" />);

    expect(screen.getByRole('link', { name: /overview/i })).toHaveAttribute('href', '#overview');
    expect(screen.getByRole('link', { name: /tasks/i })).toHaveAttribute('href', '#tasks');
    expect(screen.getByRole('link', { name: /files/i })).toHaveAttribute('href', '#files');
    expect(screen.getByRole('link', { name: /chat/i })).toHaveAttribute('href', '#chat');
  });

  it('marks the tab matching the current URL hash active [unit]', () => {
    setLocationHash('#files');

    render(<WorkspaceSheet workspaceId="ws-1" />);

    expect(screen.getByRole('link', { name: /files/i })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('link', { name: /overview/i })).toHaveAttribute(
      'data-active',
      'false',
    );
  });

  it('shows the attention dot on Tasks when a task needing the user belongs to this workspace [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-1' }, { lane: 'attention' })];

    render(<WorkspaceSheet workspaceId="ws-1" />);

    expect(screen.getByTestId('tab-strip-attention-dot')).toBeInTheDocument();
  });

  it('does not show the attention dot for a different workspace\'s attention task [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-other' }, { lane: 'attention' })];

    render(<WorkspaceSheet workspaceId="ws-1" />);

    expect(screen.queryByTestId('tab-strip-attention-dot')).not.toBeInTheDocument();
  });

  it('does not show the attention dot when no task in the workspace needs attention [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-1' }, { lane: 'queue' })];

    render(<WorkspaceSheet workspaceId="ws-1" />);

    expect(screen.queryByTestId('tab-strip-attention-dot')).not.toBeInTheDocument();
  });

  it('renders navStart/navEnd content in the bottom bar [unit]', () => {
    render(
      <WorkspaceSheet
        workspaceId="ws-1"
        navStart={<button>Search</button>}
        navEnd={<button>Profile</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
  });

  it('calls onAddClick when the add button is pressed [unit]', () => {
    const onAddClick = jest.fn();
    render(<WorkspaceSheet workspaceId="ws-1" addLabel="New task" onAddClick={onAddClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    expect(onAddClick).toHaveBeenCalledTimes(1);
  });

  it('opens the sheet to reveal the aside content when the hamburger menu is clicked [unit]', () => {
    render(<WorkspaceSheet workspaceId="ws-1" aside={<div>Sidebar content</div>} />);

    expect(screen.queryByText('Sidebar content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    expect(screen.getByText('Sidebar content')).toBeInTheDocument();
  });
});
