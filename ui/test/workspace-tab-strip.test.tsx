import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { useSignal } from '@preact/signals';

import { WorkspaceTabStrip, type DetailTab } from '@/pages/workspaces/workspace-tab-strip';
import { tasks } from '@/hooks/use-tasks';
import { boardTask } from './fixtures/board-task';

function Harness({ workspaceId, initialTab = 'overview' }: { workspaceId: string; initialTab?: DetailTab }) {
  const tab = useSignal<DetailTab>(initialTab);
  return (
    <>
      <WorkspaceTabStrip tab={tab} workspaceId={workspaceId} />
      <span data-testid="active-tab">{tab.value}</span>
    </>
  );
}

describe('WorkspaceTabStrip', () => {
  afterEach(() => {
    tasks.value = [];
    cleanup();
  });

  it('renders all four tabs [unit]', () => {
    render(<Harness workspaceId="ws-1" />);

    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /chat/i })).toBeInTheDocument();
  });

  it('updates the tab signal when a tab is clicked [unit]', () => {
    render(<Harness workspaceId="ws-1" />);

    fireEvent.click(screen.getByRole('tab', { name: /files/i }));

    expect(screen.getByTestId('active-tab')).toHaveTextContent('files');
  });

  it('shows the attention dot on Tasks when the workspace has a task needing the user [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-1' }, { lane: 'attention' })];

    render(<Harness workspaceId="ws-1" />);

    expect(screen.getByTestId('tab-strip-attention-dot')).toBeInTheDocument();
  });

  it('does not show the attention dot for a different workspace attention task [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-other' }, { lane: 'attention' })];

    render(<Harness workspaceId="ws-1" />);

    expect(screen.queryByTestId('tab-strip-attention-dot')).not.toBeInTheDocument();
  });

  it('does not show the attention dot when no task in the workspace needs attention [unit]', () => {
    tasks.value = [boardTask({ id: 't-1', workspaceId: 'ws-1' }, { lane: 'queue' })];

    render(<Harness workspaceId="ws-1" />);

    expect(screen.queryByTestId('tab-strip-attention-dot')).not.toBeInTheDocument();
  });
});
