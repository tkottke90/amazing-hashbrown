import { render, screen, fireEvent } from '@testing-library/preact';
import { WidgetCard } from '@/pages/dashboard/widget-card';

describe('WidgetCard', () => {
  describe('Edit Mode', () => {
    it('shows no resize handle outside Edit Mode [unit]', () => {
      render(
        <WidgetCard w={6} h={3} minW={3} minH={2} onResize={() => {}}>
          content
        </WidgetCard>,
      );
      expect(screen.queryByTestId('widget-resize-handle')).not.toBeInTheDocument();
    });

    it('shows the resize handle in Edit Mode [unit]', () => {
      render(
        <WidgetCard editMode w={6} h={3} minW={3} minH={2} onResize={() => {}}>
          content
        </WidgetCard>,
      );
      expect(screen.getByTestId('widget-resize-handle')).toBeInTheDocument();
    });

    it('omits the resize handle when no onResize/size is supplied, even in Edit Mode [unit]', () => {
      render(<WidgetCard editMode>content</WidgetCard>);
      expect(screen.queryByTestId('widget-resize-handle')).not.toBeInTheDocument();
    });
  });

  describe('resize handle', () => {
    function renderResizable(onResize: (w: number, h: number) => void) {
      return render(
        <WidgetCard editMode w={6} h={3} minW={3} minH={2} onResize={onResize}>
          content
        </WidgetCard>,
      );
    }

    // Two jsdom quirks stack here, both stemming from HTMLElement having no
    // native `onpointerdown` IDL property in this jsdom:
    // (1) @testing-library/preact's fireEvent.pointerDown/Move/Up helpers
    //     fall back to a broken path that dispatches a mis-cased,
    //     property-less plain Event — bypass them via the base
    //     fireEvent(el, event) two-arg form instead.
    // (2) Preact itself falls back to registering the JSX `onPointerDown`
    //     prop's *listener* under the literal mixed-case string
    //     "PointerDown" (see preact/src/diff/props.js's `lowerCaseName in
    //     dom` check), not lowercase "pointerdown" — so only the initial
    //     dispatch onto the handle (which goes through that prop) needs
    //     the mixed-case type; the hook's own `window.addEventListener`
    //     calls for move/up are plain lowercase strings, unaffected.
    function pointer(type: string, init: { clientX: number; clientY: number }) {
      return new PointerEvent(type, { ...init, pointerId: 1, bubbles: true, cancelable: true });
    }

    function mockCardWidth(card: HTMLElement, width: number) {
      jest.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        width,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }

    it('calls onResize with the new w/h on a completed drag [unit]', () => {
      const onResize = jest.fn();
      renderResizable(onResize);
      mockCardWidth(screen.getByTestId('widget-card'), 600);
      const handle = screen.getByTestId('widget-resize-handle');

      fireEvent(handle, pointer('PointerDown', { clientX: 0, clientY: 0 }));
      fireEvent(window, pointer('pointermove', { clientX: 100, clientY: 88 })); // +1 column, +1 row
      fireEvent(window, pointer('pointerup', { clientX: 100, clientY: 88 }));

      expect(onResize).toHaveBeenCalledWith(7, 4);
    });

    it('clamps a drag past the type minimum, never calling onResize below it [unit]', () => {
      const onResize = jest.fn();
      renderResizable(onResize);
      mockCardWidth(screen.getByTestId('widget-card'), 600);
      const handle = screen.getByTestId('widget-resize-handle');

      fireEvent(handle, pointer('PointerDown', { clientX: 0, clientY: 0 }));
      fireEvent(window, pointer('pointermove', { clientX: -10000, clientY: -10000 }));
      fireEvent(window, pointer('pointerup', { clientX: -10000, clientY: -10000 }));

      expect(onResize).toHaveBeenCalledWith(3, 2);
    });

    it('does not call onResize when the drag ends at the same size it started [unit]', () => {
      const onResize = jest.fn();
      renderResizable(onResize);
      mockCardWidth(screen.getByTestId('widget-card'), 600);
      const handle = screen.getByTestId('widget-resize-handle');

      fireEvent(handle, pointer('PointerDown', { clientX: 0, clientY: 0 }));
      fireEvent(window, pointer('pointermove', { clientX: 2, clientY: 2 })); // sub-column/row, rounds to 0
      fireEvent(window, pointer('pointerup', { clientX: 2, clientY: 2 }));

      expect(onResize).not.toHaveBeenCalled();
    });
  });

  it('renders children [unit]', () => {
    render(
      <WidgetCard>
        <span>child content</span>
      </WidgetCard>,
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});
