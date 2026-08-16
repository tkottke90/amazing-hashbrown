import { render } from '@testing-library/preact';
import { Drawer } from '../src/Drawer';

function getDialogEl(container: Element) {
  return container.querySelector('dialog') as HTMLDialogElement;
}

describe('Drawer', () => {
  it('defaults to docking on the right and sliding in from off-screen right', () => {
    const { container } = render(<Drawer>content</Drawer>);
    const dialog = getDialogEl(container);

    expect(dialog.className).toContain('right-0');

    const inner = dialog.querySelector('div');
    expect(inner?.className).toContain('translate-x-0');
    expect(inner?.className).toContain('starting:translate-x-full');
    expect(inner?.className).not.toContain('starting:-translate-x-full');
    expect(inner?.className).toContain('ease-out');
  });

  it('docks left and slides in from off-screen left when side="left"', () => {
    const { container } = render(<Drawer side="left">content</Drawer>);
    const dialog = getDialogEl(container);

    expect(dialog.className).toContain('left-0');

    const inner = dialog.querySelector('div');
    expect(inner?.className).toContain('starting:-translate-x-full');
  });

  it('spans the full viewport height', () => {
    const { container } = render(<Drawer>content</Drawer>);

    expect(getDialogEl(container).className).toContain('h-dvh');
  });

  it('appends a caller-provided className to the base drawer styles', () => {
    const { container } = render(<Drawer className="extra-class">content</Drawer>);

    expect(getDialogEl(container).className).toContain('extra-class');
  });
});
