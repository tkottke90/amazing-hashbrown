import { useState } from 'preact/hooks';
import { fireEvent, render, screen } from '@testing-library/preact';

import { ChatInput, ChatInputChip } from '@/components/chat-input';

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
