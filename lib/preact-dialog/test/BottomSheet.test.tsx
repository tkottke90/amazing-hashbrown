import { render } from '@testing-library/preact';
import { BottomSheet } from '../src/BottomSheet';

function getDialogEl(container: Element) {
  return container.querySelector('dialog') as HTMLDialogElement;
}

describe('BottomSheet', () => {
  it('docks to the bottom edge, spans full width, and caps height at 90% of the viewport', () => {
    const { container } = render(<BottomSheet>content</BottomSheet>);
    const dialog = getDialogEl(container);

    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).toContain('max-w-none');
    expect(dialog.className).toContain('max-h-[90dvh]');
  });

  it('wraps children in a scrollable region so content past the height cap scrolls instead of clipping', () => {
    const { container } = render(
      <BottomSheet>
        <div data-testid="child">content</div>
      </BottomSheet>,
    );

    const child = container.querySelector('[data-testid="child"]');
    const wrapper = child?.parentElement;
    expect(wrapper?.className).toContain('flex-auto');
    expect(wrapper?.className).toContain('min-h-0');
    expect(wrapper?.className).toContain('overflow-y-auto');
  });

  it('slides up from fully off-screen below, easing out', () => {
    const { container } = render(<BottomSheet>content</BottomSheet>);
    const inner = getDialogEl(container).querySelector('div');

    expect(inner?.className).toContain('translate-y-full');
    expect(inner?.className).toContain('[dialog[open]_&]:translate-y-0');
    expect(inner?.className).toContain('ease-out');
  });

  it('appends a caller-provided className to the base bottom sheet styles', () => {
    const { container } = render(<BottomSheet className="extra-class">content</BottomSheet>);

    expect(getDialogEl(container).className).toContain('extra-class');
  });
});
