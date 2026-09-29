import { signal } from '@preact/signals';
import { render, screen } from '@testing-library/preact';

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
}));

import { WorkspaceChatTab } from '@/pages/workspaces/workspace-chat-tab';
import type { Workspace } from '@/services/workspaces-api';

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

function baseWorkspace(): Workspace {
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
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    lastChange: '2026-09-28T00:00:00.000Z',
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
});
