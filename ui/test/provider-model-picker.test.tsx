import { fireEvent, render, screen } from '@testing-library/preact';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ProviderModelPicker,
  type ProviderModelPickerProps,
} from '@/components/provider-model-picker';

// jsdom has no `onpointerdown` IDL property — mirrors chat-input.test.tsx's
// helper, needed to open Radix's pointerdown-driven dropdown/submenu.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

function renderPicker(props: Partial<ProviderModelPickerProps> = {}) {
  const onSelect = jest.fn();
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ProviderModelPicker
          providers={[
            { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
            { name: 'ollama', type: 'ollama', models: [{ id: 'llama3.2' }] },
          ]}
          onSelect={onSelect}
          {...props}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  firePointerDown(screen.getByText('Open'));
  return { onSelect };
}

describe('ProviderModelPicker', () => {
  it('renders every provider and model when isModelHidden is not given', () => {
    renderPicker();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('ollama')).toBeInTheDocument();
  });

  it('hides a specific model when isModelHidden returns true for it', () => {
    renderPicker({
      isModelHidden: (provider, modelId) => provider === 'openai' && modelId === 'gpt-4o',
    });
    firePointerDown(screen.getByText('openai'));
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
  });

  it('hides a provider entirely once every one of its models is hidden', () => {
    renderPicker({
      isModelHidden: (provider) => provider === 'ollama',
    });
    expect(screen.queryByText('ollama')).not.toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
  });

  it('calls onSelect with the chosen provider and model', () => {
    const { onSelect } = renderPicker();
    firePointerDown(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o-mini'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
  });
});
