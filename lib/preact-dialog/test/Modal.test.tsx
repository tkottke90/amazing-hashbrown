import { render } from '@testing-library/preact';
import { Modal } from '../src/Modal';

function getDialogEl(container: Element) {
  return container.querySelector('dialog') as HTMLDialogElement;
}

describe('Modal', () => {
  it('centers the dialog and fades it in/out', () => {
    const { container } = render(<Modal>content</Modal>);
    const dialog = getDialogEl(container);

    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('inset-0');
    expect(dialog.className).toContain('mx-auto');
    expect(dialog.className).toContain('transition-opacity');
  });

  it('slides the content wrapper in vertically', () => {
    const { container } = render(<Modal>content</Modal>);
    const inner = getDialogEl(container).querySelector('div');

    expect(inner?.className).toContain('translate-y-1');
    expect(inner?.className).toContain('[dialog[open]_&]:translate-y-0');
  });

  it('appends a caller-provided className to the base modal styles', () => {
    const { container } = render(<Modal className="extra-class">content</Modal>);

    expect(getDialogEl(container).className).toContain('extra-class');
  });
});
