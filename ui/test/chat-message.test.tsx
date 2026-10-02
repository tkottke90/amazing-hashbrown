import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import {
  ChatMessage,
  ChatMessageCopyAction,
  ChatMessageForkAction,
  ChatMessageSaveAction,
} from '@/components/chat-message';
import { TooltipProvider } from '@/components/ui/tooltip';

function allTiles() {
  return document.querySelectorAll('[data-slot="chat-message-attachment"]');
}

const NOW = Date.now();

function slot(name: string) {
  return document.querySelector(`[data-slot="${name}"]`);
}

describe('ChatMessage', () => {
  describe('time display', () => {
    it('shows "just now" for a message sent seconds ago', () => {
      render(<ChatMessage message="hi" sentAt={new Date(NOW - 10_000)} />);
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('shows relative minutes for a message sent within the hour', () => {
      render(<ChatMessage message="hi" sentAt={new Date(NOW - 5 * 60_000)} />);
      expect(screen.getByText('5m ago')).toBeInTheDocument();
    });

    it('shows relative hours for a message sent within 24 hours', () => {
      render(<ChatMessage message="hi" sentAt={new Date(NOW - 3 * 60 * 60_000)} />);
      expect(screen.getByText('3h ago')).toBeInTheDocument();
    });

    it('shows a locale string for a message sent more than 24 hours ago', () => {
      const old = new Date(NOW - 25 * 60 * 60_000);
      render(<ChatMessage message="hi" sentAt={old} />);
      expect(screen.getByText(old.toLocaleString())).toBeInTheDocument();
    });

    it('renders the time with text-sm and opacity-50', () => {
      render(<ChatMessage message="hi" sentAt={new Date(NOW - 10_000)} />);
      const timeEl = slot('chat-message-time');
      expect(timeEl).toHaveClass('text-sm');
      expect(timeEl).toHaveClass('opacity-50');
    });

    it('always left-aligns time regardless of mirrored', () => {
      const { rerender } = render(<ChatMessage message="hi" sentAt={new Date()} />);
      expect(slot('chat-message-time')).toHaveClass('text-left');
      rerender(<ChatMessage message="hi" sentAt={new Date()} mirrored />);
      expect(slot('chat-message-time')).toHaveClass('text-left');
    });
  });

  describe('message body', () => {
    it('renders the message content', () => {
      render(<ChatMessage message="Hello, world!" sentAt={new Date()} />);
      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    });

    it('renders message via markdown', () => {
      render(<ChatMessage message="line 1\nline 2" sentAt={new Date()} />);
      const body = slot('chat-message-body');
      expect(body?.querySelector('.prose')).toBeInTheDocument();
    });
  });

  describe('actions slot', () => {
    it('renders provided actions', () => {
      render(
        <ChatMessage
          message="hi"
          sentAt={new Date()}
          actions={<button type="button">Custom</button>}
        />,
      );
      expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
    });

    it('renders nothing in the actions area when actions is omitted', () => {
      render(<ChatMessage message="hi" sentAt={new Date()} />);
      expect(slot('chat-message-actions')).toBeEmptyDOMElement();
    });
  });

  describe('attachment preview', () => {
    it('renders an image thumbnail sourced from the artifacts endpoint, as a clickable tile', () => {
      render(
        <ChatMessage
          message="check this out"
          sentAt={new Date()}
          attachments={[{ id: 'artifact-1', filename: 'photo.png', mimeType: 'image/png' }]}
        />,
      );
      const tile = allTiles()[0] as HTMLElement;
      const img = within(tile).getByAltText('photo.png') as HTMLImageElement;
      expect(img.src).toContain('/api/v1/artifacts/artifact-1');
      expect(within(tile).getByRole('button')).toBeInTheDocument();
    });

    it.each([
      ['notes.pdf', 'PDF'],
      ['notes.docx', 'DOCX'],
      ['notes.md', 'MD'],
      ['notes.txt', 'TXT'],
    ])('renders a colored extension box for %s', (filename, expectedText) => {
      render(
        <ChatMessage
          message="see attached"
          sentAt={new Date()}
          attachments={[{ id: 'artifact-1', filename, mimeType: 'application/octet-stream' }]}
        />,
      );
      const tile = allTiles()[0] as HTMLElement;
      expect(within(tile).getByText(expectedText)).toBeInTheDocument();
    });

    it('falls back to a generic gray box for an unrecognized extension', () => {
      render(
        <ChatMessage
          message="see attached"
          sentAt={new Date()}
          attachments={[
            { id: 'artifact-1', filename: 'data.xyz', mimeType: 'application/octet-stream' },
          ]}
        />,
      );
      const tile = allTiles()[0] as HTMLElement;
      const box = within(tile).getByText('XYZ');
      expect(box).toHaveClass('bg-gray-100');
    });

    it('renders nothing extra when no attachments are provided', () => {
      render(<ChatMessage message="hi" sentAt={new Date()} />);
      expect(allTiles()).toHaveLength(0);
    });

    it('renders one tile per attachment, in order, up to the 4-attachment cap', () => {
      render(
        <ChatMessage
          message="several files"
          sentAt={new Date()}
          attachments={[
            { id: 'a1', filename: 'one.png', mimeType: 'image/png' },
            { id: 'a2', filename: 'two.txt', mimeType: 'text/plain' },
          ]}
        />,
      );
      const tiles = allTiles();
      expect(tiles).toHaveLength(2);
      expect(within(tiles[0] as HTMLElement).getByAltText('one.png')).toBeInTheDocument();
      expect(within(tiles[1] as HTMLElement).getByText('TXT')).toBeInTheDocument();
    });

    it('wires the tile up as the modal trigger for an image lightbox', () => {
      // The preact-dialog mock (test/__mocks__/preact-dialog.tsx) renders a
      // Modal's content unconditionally rather than toggling it on open/
      // close — same as every other dialog test in this codebase — so this
      // asserts the lightbox content exists (distinct from the tile's own
      // thumbnail, found via its object-contain vs. object-cover class)
      // rather than simulating an actual open.
      render(
        <ChatMessage
          message="check this out"
          sentAt={new Date()}
          attachments={[{ id: 'artifact-1', filename: 'photo.png', mimeType: 'image/png' }]}
        />,
      );
      const images = screen.getAllByAltText('photo.png') as HTMLImageElement[];
      expect(images).toHaveLength(2);
      const lightboxImg = images.find((img) => img.className.includes('object-contain'));
      expect(lightboxImg?.src).toContain('/api/v1/artifacts/artifact-1');
    });

    it('wires the tile up as the modal trigger for a non-image download dialog', () => {
      render(
        <ChatMessage
          message="see attached"
          sentAt={new Date()}
          attachments={[{ id: 'artifact-1', filename: 'notes.txt', mimeType: 'text/plain' }]}
        />,
      );
      const link = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/api/v1/artifacts/artifact-1');
      expect(link.getAttribute('download')).toBe('notes.txt');
    });

    it('shows the excluded badge only on the attachment the server marked not included', () => {
      render(
        <TooltipProvider>
          <ChatMessage
            message="mixed outcome"
            sentAt={new Date()}
            attachments={[
              { id: 'included', filename: 'ok.txt', mimeType: 'text/plain', included: true },
              {
                id: 'excluded',
                filename: 'photo.png',
                mimeType: 'image/png',
                included: false,
                exclusionReason: 'vision_unsupported',
              },
            ]}
          />
        </TooltipProvider>,
      );
      const tiles = allTiles();
      expect(
        within(tiles[0] as HTMLElement).queryByRole('button', { name: /not processed/i }),
      ).toBeNull();
      expect(
        within(tiles[1] as HTMLElement).getByRole('button', { name: /not processed/i }),
      ).toBeInTheDocument();
    });

    it('shows no excluded badge while an attachment is still unresolved (included undefined)', () => {
      render(
        <ChatMessage
          message="just sent"
          sentAt={new Date()}
          attachments={[{ id: 'artifact-1', filename: 'photo.png', mimeType: 'image/png' }]}
        />,
      );
      const tile = allTiles()[0] as HTMLElement;
      expect(within(tile).queryByRole('button', { name: /not processed/i })).toBeNull();
    });
  });

  describe('mirrored layout', () => {
    it('sets data-mirrored attribute when mirrored', () => {
      render(<ChatMessage message="hi" sentAt={new Date()} mirrored />);
      expect(slot('chat-message')).toHaveAttribute('data-mirrored', 'true');
    });

    it('omits data-mirrored attribute when not mirrored', () => {
      render(<ChatMessage message="hi" sentAt={new Date()} />);
      expect(slot('chat-message')).not.toHaveAttribute('data-mirrored');
    });

    it('uses the same grid areas regardless of mirrored', () => {
      const { rerender } = render(<ChatMessage message="hi" sentAt={new Date()} />);
      expect(slot('chat-message')).toHaveStyle({
        gridTemplateAreas: '"time time time" "msg msg msg" "actions actions actions"',
      });
      rerender(<ChatMessage message="hi" sentAt={new Date()} mirrored />);
      expect(slot('chat-message')).toHaveStyle({
        gridTemplateAreas: '"time time time" "msg msg msg" "actions actions actions"',
      });
    });
  });
});

describe('ChatMessageCopyAction', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it('renders a copy button', () => {
    render(<ChatMessageCopyAction content="hello" />);
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });

  it('copies the content to the clipboard on click', async () => {
    render(<ChatMessageCopyAction content="hello markdown" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello markdown');
    });
  });
});

describe('ChatMessageForkAction', () => {
  it('renders a fork button', () => {
    render(<ChatMessageForkAction />);
    expect(screen.getByRole('button', { name: 'Fork conversation' })).toBeInTheDocument();
  });

  it('calls onFork when clicked', () => {
    const onFork = jest.fn();
    render(<ChatMessageForkAction onFork={onFork} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fork conversation' }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onFork is omitted', () => {
    render(<ChatMessageForkAction />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Fork conversation' })),
    ).not.toThrow();
  });
});

describe('ChatMessageSaveAction', () => {
  it('renders a save button', () => {
    render(<ChatMessageSaveAction content="hello" />);
    expect(screen.getByRole('button', { name: 'Save to file' })).toBeInTheDocument();
  });

  it('uses showSaveFilePicker when available', async () => {
    const mockClose = jest.fn().mockResolvedValue(undefined);
    const mockWrite = jest.fn().mockResolvedValue(undefined);
    const mockCreateWritable = jest.fn().mockResolvedValue({ write: mockWrite, close: mockClose });
    const mockPicker = jest.fn().mockResolvedValue({ createWritable: mockCreateWritable });

    Object.defineProperty(window, 'showSaveFilePicker', {
      value: mockPicker,
      configurable: true,
      writable: true,
    });

    render(<ChatMessageSaveAction content="# Hello" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save to file' }));

    await waitFor(() => {
      expect(mockPicker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: 'message.md' }),
      );
      expect(mockWrite).toHaveBeenCalledWith('# Hello');
      expect(mockClose).toHaveBeenCalled();
    });

    // Restore
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it('falls back to an anchor download when showSaveFilePicker is unavailable', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const originalCreateElement = document.createElement.bind(document);
    const anchor = originalCreateElement('a') as HTMLAnchorElement;
    const mockClick = jest.fn();
    jest.spyOn(anchor, 'click').mockImplementation(mockClick);

    const createElementSpy = jest
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        if (tag === 'a') return anchor;
        return originalCreateElement(tag);
      });

    URL.createObjectURL = jest.fn().mockReturnValue('blob:fake');
    URL.revokeObjectURL = jest.fn();

    render(<ChatMessageSaveAction content="# Hello" filename="output.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save to file' }));

    await waitFor(() => {
      expect(anchor.download).toBe('output.md');
      expect(mockClick).toHaveBeenCalled();
    });

    createElementSpy.mockRestore();
  });
});
