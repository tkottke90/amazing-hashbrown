import { fireEvent, render, screen } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useProviderModelPicker,
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

// useProviderModelPicker is a hook (it must be, so its `sheet` output can
// be rendered outside the DropdownMenu that `items` lives inside — see the
// comment in provider-model-picker.tsx) — this tiny host component is what
// actually lets it be exercised by render().
function PickerHost(props: ProviderModelPickerProps) {
  const { items, sheet } = useProviderModelPicker(props);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>{items}</DropdownMenuContent>
      </DropdownMenu>
      {sheet}
    </>
  );
}

function renderPicker(props: Partial<ProviderModelPickerProps> = {}) {
  const onSelect = jest.fn();
  render(
    <PickerHost
      providers={[
        { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
        { name: 'ollama', type: 'ollama', models: [{ id: 'llama3.2' }] },
      ]}
      onSelect={onSelect}
      {...props}
    />,
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

// Coverage for the mobile viewport pivot: on a narrow viewport, a
// provider's model list no longer nests as a second Radix flyout (long
// model names, e.g. GGUF filenames, overflowed off-screen there) — instead
// each provider is a flat, tappable item, and selecting one opens a shared
// BottomSheet with that provider's models.
describe('ProviderModelPicker — mobile viewport (<640px)', () => {
  beforeEach(() => {
    jest.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(max-width: 639px)',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as MediaQueryList);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders providers as flat items, not nested Subs', () => {
    renderPicker();
    expect(
      screen.getByText('openai').closest('[data-slot="dropdown-menu-sub-trigger"]'),
    ).toBeNull();
    expect(screen.getByText('openai').closest('[data-slot="dropdown-menu-item"]')).not.toBeNull();
  });

  it('the sheet is not visible before any provider is tapped', () => {
    renderPicker();
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });

  it("tapping a provider opens the bottom sheet listing that provider's models", () => {
    renderPicker();
    fireEvent.click(screen.getByText('openai'));
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.queryByText('llama3.2')).not.toBeInTheDocument();
  });

  it('tapping a model calls onSelect with provider+model and closes the sheet', () => {
    const { onSelect } = renderPicker();
    fireEvent.click(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o-mini'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(screen.queryByText('gpt-4o-mini')).not.toBeInTheDocument();
  });

  it('respects isModelHidden for both the flat provider list and the sheet contents', () => {
    renderPicker({
      isModelHidden: (provider, modelId) => provider === 'openai' && modelId === 'gpt-4o',
    });
    fireEvent.click(screen.getByText('openai'));
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
  });

  it('hides a provider entirely once every one of its models is hidden', () => {
    renderPicker({ isModelHidden: (provider) => provider === 'ollama' });
    expect(screen.queryByText('ollama')).not.toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
  });

  it('marks the active model with a checkmark in the sheet', () => {
    renderPicker({ activeProvider: 'openai', activeModel: 'gpt-4o' });
    fireEvent.click(screen.getByText('openai'));
    const row = screen
      .getByText('gpt-4o')
      .closest('[data-slot="provider-model-picker-sheet-item"]');
    expect(row?.querySelector('svg')).not.toBeNull();
    const otherRow = screen
      .getByText('gpt-4o-mini')
      .closest('[data-slot="provider-model-picker-sheet-item"]');
    expect(otherRow?.querySelector('svg')).toBeNull();
  });
});
