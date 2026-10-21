import { fireEvent, render, screen } from '@testing-library/preact';
import { WorkspaceRetrospectiveButton } from '@/components/workspace-retrospective-button';

describe('WorkspaceRetrospectiveButton', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('renders the outline button by default and opens the report URL in a new tab when clicked [unit]', () => {
    render(<WorkspaceRetrospectiveButton workspaceId="ws-1" />);

    fireEvent.click(screen.getByTitle('Generate retrospective report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/retrospective-report', '_blank');
  });

  it('renders the action-row variant used in the mobile Actions sheet, opening the same URL [unit]', () => {
    render(<WorkspaceRetrospectiveButton workspaceId="ws-2" variant="action-row" />);

    fireEvent.click(screen.getByTestId('actions-retrospective-report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/workspaces/ws-2/retrospective-report', '_blank');
  });
});
