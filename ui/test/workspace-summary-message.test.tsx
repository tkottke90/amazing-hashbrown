import { fireEvent, render, screen } from '@testing-library/preact';
import { WorkspaceSummaryMessage } from '@/components/workspace-summary-message';
import type { WorkspaceSummaryThreadMessage } from '@/types/thread-message';

function summaryMessage(
  overrides: Partial<WorkspaceSummaryThreadMessage> = {},
): WorkspaceSummaryThreadMessage {
  return {
    kind: 'summary',
    id: 's1',
    content: '## Continuity Summary\n\nKey decision: use SQLite.',
    summaryPath: '.hashbrown/summaries/2026-11-19T14-21-07-234Z.md',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

describe('WorkspaceSummaryMessage', () => {
  it('renders collapsed by default, with no summary content visible', () => {
    render(<WorkspaceSummaryMessage message={summaryMessage()} />);

    expect(screen.getByText('Earlier messages were summarised')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-summary-content')).not.toBeInTheDocument();
  });

  it('expands to show the markdown content and raw-file link on click', () => {
    render(<WorkspaceSummaryMessage message={summaryMessage()} />);

    fireEvent.click(screen.getByTestId('workspace-summary-toggle'));

    expect(screen.getByText('Continuity Summary')).toBeInTheDocument();
    expect(screen.getByText('Key decision: use SQLite.')).toBeInTheDocument();
    const link = screen.getByTestId('workspace-summary-raw-link');
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/workspaces/ws-1/files/.hashbrown/summaries/2026-11-19T14-21-07-234Z.md/content',
    );
  });

  it('collapses again on a second click', () => {
    render(<WorkspaceSummaryMessage message={summaryMessage()} />);

    const toggle = screen.getByTestId('workspace-summary-toggle');
    fireEvent.click(toggle);
    expect(screen.getByTestId('workspace-summary-content')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('workspace-summary-content')).not.toBeInTheDocument();
  });
});
