import { signal } from '@preact/signals';
import { render, screen, fireEvent } from '@testing-library/preact';

const mockSendWikiMessage = jest.fn().mockResolvedValue(undefined);
const mockOrientWikiThreadTo = jest.fn().mockResolvedValue(undefined);
const mockClearWikiThreadOrientation = jest.fn().mockResolvedValue(undefined);
const mockWikiOrientedTo = signal<string | null>(null);
jest.mock('@/pages/wiki/use-wiki-ingestion', () => ({
  wikiThreadId: signal('wiki-thread-1'),
  wikiOrientedTo: mockWikiOrientedTo,
  wikiDisplayMessages: signal([]),
  wikiIsStreaming: signal(false),
  wikiPendingHitlId: signal(null),
  activeWikiModel: signal(null),
  setWikiModel: jest.fn(),
  sendWikiMessage: (...args: unknown[]) => mockSendWikiMessage(...args),
  submitWikiHitlAnswer: jest.fn().mockResolvedValue(undefined),
  stopWikiGeneration: jest.fn(),
  retryWikiTurn: jest.fn().mockResolvedValue(undefined),
  newWikiThread: jest.fn(),
  orientWikiThreadTo: (...args: unknown[]) => mockOrientWikiThreadTo(...args),
  clearWikiThreadOrientation: () => mockClearWikiThreadOrientation(),
}));

jest.mock('@/hooks/use-providers', () => ({
  providers: signal([]),
  favoriteModels: signal([]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/pages/wiki/use-wiki', () => ({
  domains: signal([{ id: 'user', domain: 'user preferences', tags: [] }]),
}));

// NewDomainModal and UploadWikiDialog are unrelated dialog triggers with
// their own network calls on mount (the mocked Modal always renders its
// children, see test/__mocks__/preact-dialog.tsx) — stubbed out entirely
// since this test only covers the composer, not these dialogs.
jest.mock('../src/pages/wiki/new-domain-form', () => ({
  NewDomainModal: () => null,
}));
jest.mock('../src/pages/wiki/upload-wiki-form', () => ({
  UploadWikiDialog: () => null,
}));

import { IngestionChat } from '@/pages/wiki/ingestion-chat';

// jsdom has no `onpointerdown` IDL property — mirrors chat-input.test.tsx's
// own helper of the same name, needed here to open the add-content menu.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// Mirrors chat-input.test.tsx's own helper of the same name, needed to open
// the nested "Orient to wiki" DropdownMenuSub.
function openSubmenu(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
}

describe('IngestionChat', () => {
  beforeEach(() => {
    mockSendWikiMessage.mockClear();
    mockOrientWikiThreadTo.mockClear();
    mockClearWikiThreadOrientation.mockClear();
    mockWikiOrientedTo.value = null;
  });

  it('lets the user type, enables Send, and clears the input after sending [unit]', () => {
    render(<IngestionChat />);

    const textarea = screen.getByPlaceholderText('Add to the wiki...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'add this' } });
    expect(textarea.value).toBe('add this');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(mockSendWikiMessage).toHaveBeenCalledWith('add this', [], []);
    expect(textarea.value).toBe('');
  });

  it('calls orientWikiThreadTo with the selected domain id [unit]', () => {
    render(<IngestionChat />);

    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    openSubmenu(screen.getByRole('menuitem', { name: 'Orient to wiki' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'user' }));

    expect(mockOrientWikiThreadTo).toHaveBeenCalledWith('user');
  });

  it('shows "Clear wiki orientation" when wikiOrientedTo is set, and calls clearWikiThreadOrientation [unit]', () => {
    mockWikiOrientedTo.value = 'user';
    render(<IngestionChat />);

    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    openSubmenu(screen.getByRole('menuitem', { name: 'Orient to wiki' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear wiki orientation' }));

    expect(mockClearWikiThreadOrientation).toHaveBeenCalledTimes(1);
  });
});
