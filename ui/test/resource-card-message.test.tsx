import { fireEvent, render, screen } from '@testing-library/preact';
import { ResourceCardMessage } from '@/components/resource-card-message';
import type { ResourceCardThreadMessage } from '@/types/thread-message';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  useLocation: () => ({ route: mockRoute }),
}));

function workspaceMessage(
  overrides: Partial<ResourceCardThreadMessage> = {},
): ResourceCardThreadMessage {
  return {
    kind: 'resource_card',
    id: 'r1',
    resourceType: 'workspace',
    name: 'My Workspace',
    location: '/tmp/projects/my-workspace',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

describe('ResourceCardMessage', () => {
  beforeEach(() => {
    mockRoute.mockClear();
  });

  it('renders the resource name, type badge, and location', () => {
    render(<ResourceCardMessage message={workspaceMessage()} />);
    expect(screen.getByText('My Workspace')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('/tmp/projects/my-workspace')).toBeInTheDocument();
  });

  it('renders a Project badge for a project resource', () => {
    render(<ResourceCardMessage message={workspaceMessage({ resourceType: 'project' })} />);
    expect(screen.getByText('Project')).toBeInTheDocument();
  });

  it('renders the goal snippet when set', () => {
    render(<ResourceCardMessage message={workspaceMessage({ goal: 'Ship the thing' })} />);
    expect(screen.getByText('Ship the thing')).toBeInTheDocument();
  });

  it('does not render a goal paragraph when unset', () => {
    render(<ResourceCardMessage message={workspaceMessage()} />);
    expect(screen.queryByText('Ship the thing')).not.toBeInTheDocument();
  });

  it('navigates to /workspaces/:id when the Open link is clicked', () => {
    render(<ResourceCardMessage message={workspaceMessage({ workspaceId: 'ws-42' })} />);
    fireEvent.click(screen.getByTestId('resource-card-open-link'));
    expect(mockRoute).toHaveBeenCalledWith('/workspaces/ws-42');
  });
});
