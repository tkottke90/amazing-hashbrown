import { fireEvent, render, screen } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ProviderModelPicker,
  MODEL_SUBMENU_CLOSE_GRACE_MS,
  type ProviderModelPickerProps,
} from '@/components/provider-model-picker';

// jsdom has no `onpointerdown` IDL property — mirrors chat-input.test.tsx's
// helper, needed to open Radix's pointerdown-driven dropdown/submenu.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// Radix's DropdownMenuSubTrigger doesn't open on a bare pointerdown like the
// top-level DropdownMenuTrigger above — it opens on click, or on real
// pointer hover (timing-dependent), or an ArrowRight keypress while
// focused. Layer focus + click + keyboard so this doesn't depend on which
// of those internal paths jsdom's synthetic events actually satisfy.
// Uses fireEvent.focus (not a bare element.focus()) so the app-controlled
// open state ProviderModelPicker now drives its Sub with (see issue #113's
// fix) is flushed to the DOM before the click/keyDown below read it — a
// raw .focus() call isn't wrapped in Preact Testing Library's act(), so a
// render it triggers can be observed as stale by the very next line.
function openSubmenu(element: HTMLElement) {
  fireEvent.focus(element);
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
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
    openSubmenu(screen.getByText('openai'));
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
    openSubmenu(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o-mini'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
  });
});

// Regression coverage for issue #113: the per-provider sub-menu previously
// closed before the pointer/keyboard could reach it, because it relied on
// Radix's own hover/focus timing for nested Sub components, which is
// unreliable at this nesting depth. These exercise the app-controlled
// open state (grace-delay close, cancel-on-re-entry) that replaced it.
describe('ProviderModelPicker — hover-open grace window (issue #113)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('stays open when the pointer leaves the trigger and enters the content mid-grace-window, and the model is still selectable', () => {
    const { onSelect } = renderPicker();
    const trigger = screen.getByText('openai');

    fireEvent.pointerEnter(trigger);
    const content = screen.getByText('gpt-4o').closest('[data-slot="dropdown-menu-sub-content"]');
    expect(content).not.toBeNull();

    fireEvent.pointerLeave(trigger);
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS / 2);
    });
    fireEvent.pointerEnter(content as Element);
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    fireEvent.click(screen.getByText('gpt-4o'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('closes after the grace delay when the pointer leaves and never returns', () => {
    renderPicker();
    const trigger = screen.getByText('openai');

    fireEvent.pointerEnter(trigger);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    fireEvent.pointerLeave(trigger);
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS - 1);
    });
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });

  it('switches directly between sibling providers without a stuck-open state', () => {
    renderPicker();
    const openaiTrigger = screen.getByText('openai');
    const ollamaTrigger = screen.getByText('ollama');

    fireEvent.pointerEnter(openaiTrigger);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    fireEvent.pointerLeave(openaiTrigger);
    fireEvent.pointerEnter(ollamaTrigger);

    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
    expect(screen.getByText('llama3.2')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });
    expect(screen.getByText('llama3.2')).toBeInTheDocument();
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });
});
