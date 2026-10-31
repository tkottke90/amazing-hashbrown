import { signal } from '@preact/signals';
import { render, screen, fireEvent } from '@testing-library/preact';

import type { ThreadInstance } from '@/hooks/use-thread';

const mockUseThreadInstance = jest.fn();
jest.mock('@/hooks/use-thread', () => ({
  useThreadInstance: (...args: unknown[]) => mockUseThreadInstance(...args),
  activeThreadId: signal('thread-1'),
  threads: signal([]),
  activeThreadAfterAgentState: signal({ status: 'idle' }),
  forkThread: jest.fn().mockResolvedValue('forked-thread-1'),
  refreshThreadList: jest.fn().mockResolvedValue(undefined),
  switchThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/hooks/use-providers', () => ({
  providers: signal([]),
  favoriteModels: signal([]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
}));

import { ThreadView } from '@/pages/chat';

// Mirrors workspace-chat-tab.test.tsx's own stubThreadInstance() — this file
// has no shared helper to import from, so it's duplicated here rather than
// introducing a cross-test-file dependency for one small object.
function stubThreadInstance(): ThreadInstance {
  return {
    messages: signal([]),
    displayMessages: signal([]),
    isStreaming: signal(false),
    pendingHitlId: signal(null),
    activeThreadModel: signal(null),
    modelHydrated: signal(true),
    isSummarizing: signal(false),
    summaryPath: signal(null),
    isWaitingForProvider: signal(false),
    waitingProviderName: signal(null),
    threadType: signal(null),
    taskRun: signal(null),
    archivedAt: signal(null),
    title: signal(null),
    backgroundTurnActive: signal(false),
    markBackgroundTurn: jest.fn(),
    setThreadModel: jest.fn(),
    hydrate: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    submitHitlAnswer: jest.fn().mockResolvedValue(undefined),
    retryTurn: jest.fn().mockResolvedValue(undefined),
    stopGeneration: jest.fn(),
  };
}

describe('ThreadView', () => {
  it('lets the user type, enables Send, and clears the input after sending [unit]', () => {
    const thread = stubThreadInstance();
    mockUseThreadInstance.mockReturnValue(thread);
    render(<ThreadView />);

    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hello thread' } });
    expect(textarea.value).toBe('hello thread');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(thread.sendMessage).toHaveBeenCalledWith('hello thread', []);
    expect(textarea.value).toBe('');
  });

  it('disables Send while the pending text is only whitespace [unit]', () => {
    mockUseThreadInstance.mockReturnValue(stubThreadInstance());
    render(<ThreadView />);

    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
