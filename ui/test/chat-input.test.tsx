import { useState } from 'preact/hooks';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { ChatInput, ChatInputChip } from '@/components/chat-input';
import { TooltipProvider } from '@/components/ui/tooltip';

function ControlledChatInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const [value, setValue] = useState(props.value ?? '');
  return <ChatInput value={value} onValueChange={setValue} onSend={() => {}} {...props} />;
}

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name (e.g.
// "PointerDown" instead of "pointerdown") — mirror that here so Radix's
// pointerdown-driven open handlers actually receive the event.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// Radix's DropdownMenuSubTrigger doesn't open on a bare pointerdown like the
// top-level DropdownMenuTrigger above — it opens on click, or on real
// pointer hover (timing-dependent), or an ArrowRight keypress while
// focused. Layer click + keyboard so this doesn't depend on which of
// those internal paths jsdom's synthetic events actually satisfy.
function openSubmenu(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
}

// @testing-library/preact's fireEvent.change/fireEvent.input wrappers never
// reach a <input type="file">'s listener when a Radix component is also
// mounted in the tree (confirmed: this only affects type="file" specifically
// — a type="text" sibling's fireEvent.change works fine under the same
// conditions, and a raw, non-Preact addEventListener('change', ...) on the
// exact same node also never fires through the wrapper). A plain
// `element.dispatchEvent(new Event('change', {bubbles:true}))` — bypassing
// the wrapper entirely — reaches the listener correctly and is exactly what
// a real browser does on file selection, so that's what this drives instead.
function fireFileInputChange(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

describe('ChatInput', () => {
  it('renders the textarea with the given placeholder', () => {
    render(<ControlledChatInput placeholder="Ask anything" />);
    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
  });

  it('updates value as the user types', () => {
    render(<ControlledChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hello' } });
    expect(textarea.value).toBe('hello');
  });

  it('renders header chips when provided', () => {
    render(<ControlledChatInput header={<ChatInputChip>file.png</ChatInputChip>} />);
    expect(screen.getByText('file.png')).toBeInTheDocument();
  });

  it('caps a chip at 300px and truncates its text', () => {
    render(<ChatInputChip>a-very-long-filename-that-should-truncate.png</ChatInputChip>);
    const text = screen.getByText('a-very-long-filename-that-should-truncate.png');
    const chip = text.closest('[data-slot="chat-input-chip"]');
    expect(chip).toHaveClass('max-w-[300px]');
    expect(text).toHaveAttribute('data-slot', 'text-ellipsis');
  });

  it('has no remove button when onRemove is not provided', () => {
    render(<ChatInputChip>file.png</ChatInputChip>);
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows a remove button and calls onRemove when clicked', () => {
    const onRemove = jest.fn();
    render(<ChatInputChip onRemove={onRemove}>file.png</ChatInputChip>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('disables send until there is text', () => {
    render(<ControlledChatInput />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('calls onSend when send is clicked with text present', () => {
    const onSend = jest.fn();
    render(<ControlledChatInput value="hi" onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows a stop button and calls onStop while generating', () => {
    const onStop = jest.fn();
    render(<ControlledChatInput isGenerating onStop={onStop} />);
    const stopButton = screen.getByRole('button', { name: 'Stop generating' });
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('opens the add-content menu and exposes the add file placeholder', () => {
    const onAddFile = jest.fn();
    render(<ControlledChatInput onAddFile={onAddFile} />);
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    const item = screen.getByText('Add file');
    fireEvent.click(item);
    expect(onAddFile).toHaveBeenCalledTimes(1);
  });

  it('opens the provider submenu and lists the configured providers', () => {
    const onModelSelect = jest.fn();
    render(
      <ControlledChatInput
        onModelSelect={onModelSelect}
        providers={[
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
          { name: 'ollama', type: 'ollama', models: [{ id: 'llama3.2' }] },
        ]}
      />,
    );

    // This only proves ChatInput wires providers/onModelSelect into
    // ProviderModelPicker correctly (the "Provider" submenu renders both
    // configured providers). ProviderModelPicker's own test covers the
    // deeper provider->model->onSelect flow — a third level of nested
    // Radix submenu-in-a-submenu isn't reliably openable via jsdom's
    // synthetic events the way a single level of nesting is.
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    openSubmenu(screen.getByText('Provider'));

    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('ollama')).toBeInTheDocument();
  });
});

describe('ChatInput — file attachment', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockUploadSuccess(overrides: Partial<Record<string, unknown>> = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'artifact-1',
        mimeType: 'image/png',
        displayFilename: 'photo.png',
        requiresVision: true,
        ...overrides,
      }),
    }) as unknown as typeof fetch;
  }

  it('uploads a selected file and renders a chip, calling onAttachmentChange', async () => {
    mockUploadSuccess();
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bytes'], 'photo.png', { type: 'image/png' });
    fireFileInputChange(input, file);

    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/artifacts',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onAttachmentChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'artifact-1', displayFilename: 'photo.png' }),
    );
  });

  it('shows an inline error and does not call onAttachmentChange when the upload fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Unsupported file type' }),
    }) as unknown as typeof fetch;
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'bad.zip', { type: 'application/zip' }));

    await waitFor(() => expect(screen.getByText('Unsupported file type')).toBeInTheDocument());
    expect(onAttachmentChange).not.toHaveBeenCalled();
  });

  it('clicking the chip remove button deletes the artifact and clears the attachment', async () => {
    mockUploadSuccess();
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());

    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/artifacts/artifact-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
    expect(onAttachmentChange).toHaveBeenLastCalledWith(null);
  });

  it('dropping a file uploads it the same way as the file picker', async () => {
    mockUploadSuccess({ displayFilename: 'dropped.png' });
    render(<ControlledChatInput threadId="t1" />);

    const dropZone = document.querySelector('[data-slot="chat-input"]') as HTMLElement;
    const file = new File(['bytes'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText('dropped.png')).toBeInTheDocument());
  });

  it('does nothing on drop/select when no threadId is given', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<ControlledChatInput />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('ChatInput — vision-capability warning badge', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function renderWithStagedImage(
    providers: Parameters<typeof ControlledChatInput>[0]['providers'],
  ) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'artifact-1',
        mimeType: 'image/png',
        displayFilename: 'photo.png',
        requiresVision: true,
      }),
    }) as unknown as typeof fetch;

    render(
      <TooltipProvider>
        <ControlledChatInput
          threadId="t1"
          activeProvider="ollama"
          activeModel="llava"
          providers={providers}
        />
      </TooltipProvider>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));
  }

  it('shows the warning badge when the attachment requires vision and the model does not support it', async () => {
    renderWithStagedImage([
      { name: 'ollama', type: 'ollama', models: [{ id: 'llava', imageInput: false }] },
    ]);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /does not support image input/ }),
      ).toBeInTheDocument(),
    );
  });

  it('hides the warning badge when the model supports vision', async () => {
    renderWithStagedImage([
      { name: 'ollama', type: 'ollama', models: [{ id: 'llava', imageInput: true }] },
    ]);

    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: /does not support image input/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the warning badge when no model is known for the provider (conservative default)', async () => {
    renderWithStagedImage([{ name: 'ollama', type: 'ollama', models: [] }]);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /does not support image input/ }),
      ).toBeInTheDocument(),
    );
  });
});
