import { fireEvent, render, screen } from '@testing-library/preact';
import { SubAgentMarkerMessage } from '@/components/sub-agent-marker-message';
import type { SubAgentMarkerThreadMessage } from '@/types/thread-message';

const mockRoute = jest.fn();
let mockPath = '/chat/current-thread';
jest.mock('preact-iso', () => ({
  useLocation: () => ({ path: mockPath, route: mockRoute }),
}));

function subAgentMarkerMessage(
  overrides: Partial<SubAgentMarkerThreadMessage> = {},
): SubAgentMarkerThreadMessage {
  return {
    kind: 'sub_agent_marker',
    id: 'm1',
    taskId: 'task-1',
    role: 'researcher',
    phase: 'dispatch',
    ...overrides,
  };
}

describe('SubAgentMarkerMessage', () => {
  beforeEach(() => {
    mockRoute.mockClear();
    mockPath = '/chat/current-thread';
  });

  it('renders dispatch-phase text with the role, and no Open-run link', () => {
    render(<SubAgentMarkerMessage message={subAgentMarkerMessage()} />);
    expect(screen.getByText('researcher')).toBeInTheDocument();
    expect(screen.queryByTestId('sub-agent-marker-open')).not.toBeInTheDocument();
  });

  it('renders a completion-phase outcome label', () => {
    render(
      <SubAgentMarkerMessage
        message={subAgentMarkerMessage({ phase: 'completion', outcome: 'done' })}
      />,
    );
    expect(screen.getByText(/completed/)).toBeInTheDocument();
  });

  it('renders the sibling count only when remainingCount is above zero', () => {
    render(
      <SubAgentMarkerMessage
        message={subAgentMarkerMessage({ phase: 'completion', outcome: 'done', remainingCount: 2 })}
      />,
    );
    expect(screen.getByText(/2 sibling\(s\) still running/)).toBeInTheDocument();
  });

  it('renders no sibling count when remainingCount is zero', () => {
    render(
      <SubAgentMarkerMessage
        message={subAgentMarkerMessage({ phase: 'completion', outcome: 'done', remainingCount: 0 })}
      />,
    );
    expect(screen.queryByText(/sibling\(s\) still running/)).not.toBeInTheDocument();
  });

  it('renders the Open-run link on a completion marker with a runThreadId, and navigates on click', () => {
    render(
      <SubAgentMarkerMessage
        message={subAgentMarkerMessage({
          phase: 'completion',
          outcome: 'done',
          runThreadId: 'run-1',
        })}
      />,
    );
    const link = screen.getByTestId('sub-agent-marker-open');
    fireEvent.click(link);
    expect(mockRoute).toHaveBeenCalledWith('/chat/run-1');
  });

  it('renders no Open-run link on a completion marker with no runThreadId yet', () => {
    render(
      <SubAgentMarkerMessage
        message={subAgentMarkerMessage({ phase: 'completion', outcome: 'done' })}
      />,
    );
    expect(screen.queryByTestId('sub-agent-marker-open')).not.toBeInTheDocument();
  });
});
