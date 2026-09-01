import { fireEvent, render, screen } from '@testing-library/preact';
import { AssistantMessage } from '@/components/assistant-message';
import { showErrorMessages, setShowErrorMessages } from '@/hooks/use-thread';
import type { AssistantThreadMessage } from '@/types/thread-message';

function baseMessage(overrides: Partial<AssistantThreadMessage> = {}): AssistantThreadMessage {
  return {
    kind: 'assistant',
    id: 'a1',
    status: 'done',
    content: '',
    sentAt: new Date(),
    ...overrides,
  };
}

afterEach(() => {
  setShowErrorMessages(false);
});

describe('AssistantMessage — error rendering', () => {
  it('shows partial content plus an inline indicator instead of replacing it, on error', () => {
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'Here is what I had' })}
      />,
    );

    expect(screen.getByText('Here is what I had')).toBeInTheDocument();
    expect(screen.getByText('Response interrupted')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
  });

  it('falls back to the generic message only when there is no content at all', () => {
    render(<AssistantMessage message={baseMessage({ status: 'error', content: '' })} />);

    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('shows a Retry action for an unresolved (non-superseded) error when onRetry is given', () => {
    const onRetry = jest.fn();
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'oops' })}
        onRetry={onRetry}
      />,
    );

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('AssistantMessage — superseded (retried-over) rows', () => {
  it('renders collapsed by default, hiding its content', () => {
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'the failed attempt', superseded: true })}
      />,
    );

    expect(screen.getByText('Attempt failed — click to view')).toBeInTheDocument();
    expect(screen.queryByText('the failed attempt')).not.toBeInTheDocument();
  });

  it('expands on click to show content plus the error indicator, and never shows Retry', () => {
    const onRetry = jest.fn();
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'the failed attempt', superseded: true })}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByText('Attempt failed — click to view'));

    expect(screen.getByText('the failed attempt')).toBeInTheDocument();
    expect(screen.getByText('Response interrupted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders expanded by default when the expand-all preference is on', () => {
    setShowErrorMessages(true);
    expect(showErrorMessages.value).toBe(true);

    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'the failed attempt', superseded: true })}
      />,
    );

    expect(screen.getByText('the failed attempt')).toBeInTheDocument();
    expect(screen.queryByText('Attempt failed — click to view')).not.toBeInTheDocument();
  });

  it('a single row can still collapse itself even while expand-all is on', () => {
    setShowErrorMessages(true);

    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: 'the failed attempt', superseded: true })}
      />,
    );

    fireEvent.click(screen.getByTitle('Collapse'));

    expect(screen.getByText('Attempt failed — click to view')).toBeInTheDocument();
  });
});
