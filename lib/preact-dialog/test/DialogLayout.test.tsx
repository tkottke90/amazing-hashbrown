import { render } from '@testing-library/preact';
import { DialogBody, DialogFooter } from '../src/DialogLayout';

function classesOf(el: Element | null) {
  return (el?.className ?? '').split(/\s+/);
}

describe('DialogBody', () => {
  it('is the scroll region, so overflowing content scrolls instead of pushing the footer off-screen', () => {
    const { container } = render(<DialogBody>content</DialogBody>);
    const body = container.querySelector('[data-slot="dialog-body"]');

    expect(classesOf(body)).toEqual(
      expect.arrayContaining(['flex-auto', 'min-h-0', 'overflow-y-auto']),
    );
  });

  it('applies the default padding shared with the drawer header when no className is given', () => {
    const { container } = render(<DialogBody>content</DialogBody>);
    const body = container.querySelector('[data-slot="dialog-body"]');

    expect(classesOf(body)).toEqual(expect.arrayContaining(['px-5', 'py-4']));
  });

  it('lets a caller className replace the default padding rather than stacking with it', () => {
    const { container } = render(<DialogBody className="p-0">content</DialogBody>);
    const classes = classesOf(container.querySelector('[data-slot="dialog-body"]'));

    expect(classes).toContain('p-0');
    expect(classes).not.toContain('px-5');
    expect(classes).not.toContain('py-4');
  });

  it('renders its children', () => {
    const { getByText } = render(<DialogBody>hello body</DialogBody>);

    expect(getByText('hello body')).toBeTruthy();
  });
});

describe('DialogFooter', () => {
  it('never shrinks, so the actions stay full-size when the body overflows', () => {
    const { container } = render(<DialogFooter>actions</DialogFooter>);
    const classes = classesOf(container.querySelector('[data-slot="dialog-footer"]'));

    expect(classes).toEqual(expect.arrayContaining(['shrink-0', 'border-t']));
  });

  it('right-aligns actions by default', () => {
    const { container } = render(<DialogFooter>actions</DialogFooter>);

    expect(classesOf(container.querySelector('[data-slot="dialog-footer"]'))).toContain(
      'justify-end',
    );
  });

  it('lets a caller className replace the default alignment and border colour', () => {
    const { container } = render(
      <DialogFooter className="justify-between border-border">actions</DialogFooter>,
    );
    const classes = classesOf(container.querySelector('[data-slot="dialog-footer"]'));

    expect(classes).toContain('justify-between');
    expect(classes).not.toContain('justify-end');
    expect(classes).toContain('border-border');
    expect(classes).not.toContain('border-neutral-400/50');
  });
});
