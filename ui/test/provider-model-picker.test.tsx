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

// jsdom has no native PointerEvent either, so `fireEvent.pointerEnter`/
// `pointerLeave` silently drop the `pointerType` from their init object —
// the event Preact's handler receives always has `pointerType: undefined`.
// Preact itself falls back to registering onPointerEnter/onPointerLeave
// under the un-lowercased event name (same fallback as onPointerDown
// above), so building a plain Event under that literal name and attaching
// `pointerType` directly is what actually reaches the handler with the
// value this suite needs to exercise `whenMouse` (issue #130).
function firePointerEvent(
  element: Element,
  type: 'PointerEnter' | 'PointerLeave',
  pointerType: 'mouse' | 'touch',
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
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

    firePointerEvent(trigger, 'PointerEnter', 'mouse');
    const content = screen.getByText('gpt-4o').closest('[data-slot="dropdown-menu-sub-content"]');
    expect(content).not.toBeNull();

    firePointerEvent(trigger, 'PointerLeave', 'mouse');
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS / 2);
    });
    firePointerEvent(content as Element, 'PointerEnter', 'mouse');
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

    firePointerEvent(trigger, 'PointerEnter', 'mouse');
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    firePointerEvent(trigger, 'PointerLeave', 'mouse');
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

    firePointerEvent(openaiTrigger, 'PointerEnter', 'mouse');
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    firePointerEvent(openaiTrigger, 'PointerLeave', 'mouse');
    firePointerEvent(ollamaTrigger, 'PointerEnter', 'mouse');

    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
    expect(screen.getByText('llama3.2')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });
    expect(screen.getByText('llama3.2')).toBeInTheDocument();
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });
});

// Regression coverage for issue #130: touch has no real hover state, but our
// own onPointerEnter/onPointerLeave handlers (added for #113 above) never
// guarded against non-mouse pointer types the way Radix's own internal
// pointer-hover handlers do (see provider-model-picker.tsx's `whenMouse`).
// A touch tap's synthesized pointerleave was arming the same close timer
// meant only for a real pointer moving away, racing the user's next tap.
describe('ProviderModelPicker — touch never schedules a hover-close (issue #130)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('a touch pointerLeave on the trigger never schedules a close', () => {
    renderPicker();
    const trigger = screen.getByText('openai');

    firePointerEvent(trigger, 'PointerEnter', 'mouse');
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    firePointerEvent(trigger, 'PointerLeave', 'touch');
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('a touch pointerLeave on the content never schedules a close', () => {
    renderPicker();
    const trigger = screen.getByText('openai');

    firePointerEvent(trigger, 'PointerEnter', 'mouse');
    const content = screen.getByText('gpt-4o').closest('[data-slot="dropdown-menu-sub-content"]');
    expect(content).not.toBeNull();

    firePointerEvent(content as Element, 'PointerLeave', 'touch');
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it("a touch user can still open the model list and select via tap/click (Radix's own click-to-open path)", () => {
    const { onSelect } = renderPicker();
    openSubmenu(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o');
  });
});
