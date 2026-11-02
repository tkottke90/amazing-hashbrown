import { fireEvent, render, screen } from '@testing-library/preact';
import { OpenRunLink } from '@/components/open-run-link';

const mockRoute = jest.fn();
let mockPath = '/chat/current-thread';
jest.mock('preact-iso', () => ({
  useLocation: () => ({ path: mockPath, route: mockRoute }),
}));

describe('OpenRunLink', () => {
  beforeEach(() => {
    mockRoute.mockClear();
    mockPath = '/chat/current-thread';
  });

  it('renders nothing when there is no run thread to link to', () => {
    render(<OpenRunLink runThreadId={undefined} testId="open-run-open" />);
    expect(screen.queryByTestId('open-run-open')).not.toBeInTheDocument();
  });

  it('renders nothing when already on the linked run\'s own page', () => {
    mockPath = '/chat/run-1';
    render(<OpenRunLink runThreadId="run-1" testId="open-run-open" />);
    expect(screen.queryByTestId('open-run-open')).not.toBeInTheDocument();
  });

  it('renders the link, and navigates to the run on click, when a different run thread is given', () => {
    render(<OpenRunLink runThreadId="run-1" testId="open-run-open" />);
    const link = screen.getByTestId('open-run-open');
    fireEvent.click(link);
    expect(mockRoute).toHaveBeenCalledWith('/chat/run-1');
  });

  it('renders with the caller-provided test id', () => {
    render(<OpenRunLink runThreadId="run-1" testId="sub-agent-marker-open" />);
    expect(screen.getByTestId('sub-agent-marker-open')).toBeInTheDocument();
  });
});
