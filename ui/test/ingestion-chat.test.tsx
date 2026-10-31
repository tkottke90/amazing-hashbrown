import { signal } from '@preact/signals';
import { render, screen, fireEvent } from '@testing-library/preact';

const mockSendWikiMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('@/pages/wiki/use-wiki-ingestion', () => ({
  wikiThreadId: signal('wiki-thread-1'),
  wikiOrientedTo: signal(null),
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
}));

jest.mock('@/hooks/use-providers', () => ({
  providers: signal([]),
  favoriteModels: signal([]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
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

describe('IngestionChat', () => {
  beforeEach(() => {
    mockSendWikiMessage.mockClear();
  });

  it('lets the user type, enables Send, and clears the input after sending [unit]', () => {
    render(<IngestionChat />);

    const textarea = screen.getByPlaceholderText('Add to the wiki...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'add this' } });
    expect(textarea.value).toBe('add this');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(mockSendWikiMessage).toHaveBeenCalledWith('add this', []);
    expect(textarea.value).toBe('');
  });
});
