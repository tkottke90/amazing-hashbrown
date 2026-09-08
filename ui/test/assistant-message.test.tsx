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

  it('shows a Retry action regardless of errorCategory — its presence never implies retrying will help', () => {
    const onRetry = jest.fn();
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: '', errorCategory: 'billing' })}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  const CATEGORY_COPY: Record<string, string> = {
    auth: 'Authentication failed — check that your API key for this provider is valid.',
    billing:
      "This provider account is out of credit or has a billing issue. Retrying won't help until that's resolved.",
    rate_limit: 'The provider is rate-limiting requests. Wait a bit before retrying.',
    context_length:
      "This conversation is too long for the model's context window. Try starting a new thread or shortening it.",
    content_policy:
      "The provider declined this request for policy reasons. Rephrasing may help; retrying as-is won't.",
    unavailable:
      'The model or provider is temporarily unavailable. This is usually transient — retrying may work.',
    network: "Couldn't reach the provider — check your connection.",
  };

  for (const [category, copy] of Object.entries(CATEGORY_COPY)) {
    it(`renders the ${category} category's own copy instead of the generic message`, () => {
      render(
        <AssistantMessage
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          message={baseMessage({ status: 'error', content: '', errorCategory: category as any })}
        />,
      );

      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
    });
  }

  it('renders the generic message for an explicit "unknown" category, same as no category at all', () => {
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: '', errorCategory: 'unknown' })}
      />,
    );

    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('hides the raw provider detail behind a "Show details" toggle', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          status: 'error',
          content: '',
          errorCategory: 'billing',
          error: 'insufficient credit balance for account acct_123',
        })}
      />,
    );

    expect(
      screen.queryByText('insufficient credit balance for account acct_123'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Show details'));

    expect(
      screen.getByText('insufficient credit balance for account acct_123'),
    ).toBeInTheDocument();
  });

  it('renders no "Show details" toggle when a category is set but no raw detail is available', () => {
    render(
      <AssistantMessage
        message={baseMessage({ status: 'error', content: '', errorCategory: 'network' })}
      />,
    );

    expect(screen.queryByText('Show details')).not.toBeInTheDocument();
  });
});

describe('AssistantMessage — metrics row', () => {
  it('renders duration, tok/s, cost, and token breakdown together', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: 'here you go',
          durationMs: 2300,
          cost: { tokensPerSecond: 14.2, dollars: 0.0031 },
          usage: { inputTokens: 512, outputTokens: 128 },
        })}
      />,
    );

    expect(screen.getByText('2.3s')).toBeInTheDocument();
    expect(screen.getByText('14.2 tok/s')).toBeInTheDocument();
    expect(screen.getByText('$0.0031')).toBeInTheDocument();
    expect(screen.getByText('(512 in / 128 out)')).toBeInTheDocument();
  });

  it('renders token breakdown with thousands separators', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: 'here you go',
          durationMs: 2300,
          usage: { inputTokens: 12345, outputTokens: 6789 },
        })}
      />,
    );

    expect(screen.getByText('(12,345 in / 6,789 out)')).toBeInTheDocument();
  });

  it('renders duration and tokens without a dollar figure when no cost rate is configured', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: 'here you go',
          durationMs: 2300,
          cost: { tokensPerSecond: 14.2 },
          usage: { inputTokens: 512, outputTokens: 128 },
        })}
      />,
    );

    expect(screen.getByText('2.3s')).toBeInTheDocument();
    expect(screen.getByText('14.2 tok/s')).toBeInTheDocument();
    expect(screen.getByText('(512 in / 128 out)')).toBeInTheDocument();
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it('omits the metrics row entirely for a message with no durationMs/cost/usage', () => {
    render(<AssistantMessage message={baseMessage({ content: 'here you go' })} />);

    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ in \/ /)).not.toBeInTheDocument();
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
