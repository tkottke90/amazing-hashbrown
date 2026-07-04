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
});
