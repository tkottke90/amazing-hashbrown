import { signal } from '@preact/signals';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

import type { ThreadInstance } from '@/hooks/use-thread';

const mockUseThreadInstance = jest.fn();
jest.mock('@/hooks/use-thread', () => ({
  useThreadInstance: (...args: unknown[]) => mockUseThreadInstance(...args),
}));

jest.mock('@/hooks/use-providers', () => ({
  providers: signal([]),
  favoriteModels: signal([]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/hooks/use-workspaces', () => ({
  patchWorkspace: jest.fn().mockResolvedValue(undefined),
  refreshWorkspaces: jest.fn().mockResolvedValue(undefined),
  applyThreadReplacement: jest.fn(),
}));

import { WorkspaceChatTab } from '@/pages/workspaces/workspace-chat-tab';
import { patchWorkspace, applyThreadReplacement } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';

// jsdom has no `onpointerdown` IDL property — mirrors chat-input.test.tsx's
// own helper of the same name, needed here to open the add-content menu.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

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

function baseWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Infisical Setup',
    description: null,
    goal: null,
    location: '/app/config/projects/infisical-setup',
    managedLocation: true,
    git: false,
    remoteUrl: null,
    wikiId: null,
    javascript: false,
    python: false,
    systemPrompt: null,
    // A real threadId so the tab doesn't PATCH one into existence — keeps
    // this test focused on the focus/blur wiring, not thread creation.
    threadId: 'thread-1',
    summaryPath: null,
    lastSummarizedMessageId: null,
    autoApproveShell: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    lastChange: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('WorkspaceChatTab', () => {
  beforeEach(() => {
    mockUseThreadInstance.mockReturnValue(stubThreadInstance());
  });

  it('fires onInputFocusChange(true) when the chat input is focused, and (false) on blur [unit]', () => {
    const onInputFocusChange = jest.fn();
    render(
      <WorkspaceChatTab workspace={baseWorkspace()} onInputFocusChange={onInputFocusChange} />,
    );

    // preact/compat remaps onFocus/onBlur to the bubbling focusin/focusout
    // events — fireEvent.focus()/blur() dispatch the native, non-bubbling
    // events instead and never reach them, so real DOM focus()/blur() calls
    // are used here (see chat-input.test.tsx's matching note).
    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    textarea.focus();
    expect(onInputFocusChange).toHaveBeenCalledWith(true);

    textarea.blur();
    expect(onInputFocusChange).toHaveBeenCalledWith(false);
  });

  it('does not throw when onInputFocusChange is omitted [unit]', () => {
    render(<WorkspaceChatTab workspace={baseWorkspace()} />);

    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    expect(() => textarea.focus()).not.toThrow();
  });

  it('toggles autoApproveShell via the add-menu item, flipping the current value', () => {
    render(<WorkspaceChatTab workspace={baseWorkspace()} />);

    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    fireEvent.click(screen.getByTestId('auto-approve-menu-item'));

    expect(patchWorkspace).toHaveBeenCalledWith('ws-1', { autoApproveShell: true });
  });

  it('shows the Auto chip when the workspace already has it enabled, and toggling it flips back off', () => {
    render(<WorkspaceChatTab workspace={baseWorkspace({ autoApproveShell: true })} />);

    const chip = screen.getByTestId('auto-approve-chip');
    fireEvent.click(chip);

    expect(patchWorkspace).toHaveBeenCalledWith('ws-1', { autoApproveShell: false });
  });

  it('lets the user type, enables Send, and clears the input after sending [unit]', () => {
    const thread = stubThreadInstance();
    mockUseThreadInstance.mockReturnValue(thread);
    render(<WorkspaceChatTab workspace={baseWorkspace()} />);

    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hello workspace' } });
    expect(textarea.value).toBe('hello workspace');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(thread.sendMessage).toHaveBeenCalledWith('hello workspace', [], []);
    expect(textarea.value).toBe('');
  });

  describe('Replace Thread', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ threadId: 'new-thread-99', archivedThreadId: 'thread-1' }),
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      jest.clearAllMocks();
      mockUseThreadInstance.mockReturnValue(stubThreadInstance());
    });

    it('shows a confirm/cancel pair instead of posting immediately on first click [unit]', () => {
      render(<WorkspaceChatTab workspace={baseWorkspace()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Replace Thread' }));

      expect(screen.getByText('Replace this thread?')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('cancelling returns to the plain button row without ever calling fetch [unit]', () => {
      render(<WorkspaceChatTab workspace={baseWorkspace()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Replace Thread' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Replace this thread?')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Replace Thread' })).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('confirming posts to the replace endpoint and merges the new threadId in [unit]', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ threadId: 'new-thread-99', archivedThreadId: 'thread-1' }),
      }) as unknown as typeof fetch;

      render(<WorkspaceChatTab workspace={baseWorkspace()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Replace Thread' }));
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/v1/workspaces/ws-1/chat/thread-1/replace',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      await waitFor(() =>
        expect(applyThreadReplacement).toHaveBeenCalledWith('ws-1', 'new-thread-99'),
      );
    });

    it('a failed replace call leaves the confirm row up and does not merge anything [unit]', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;

      render(<WorkspaceChatTab workspace={baseWorkspace()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Replace Thread' }));
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(applyThreadReplacement).not.toHaveBeenCalled();
      expect(screen.getByText('Replace this thread?')).toBeInTheDocument();
    });
  });
});
