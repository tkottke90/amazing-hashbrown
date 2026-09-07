import { act, fireEvent, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { Dialog, useDialog } from '../src/Dialog';

function getDialogEl(container: Element) {
  return container.querySelector('dialog') as HTMLDialogElement;
}

// The X close button lives inside the <dialog>. jsdom's default stylesheet
// hides descendants of a <dialog> without an `open` attribute
// (`dialog:not([open]) { display: none }`), so role-based queries against
// them only resolve once the dialog has actually been opened.
function openDialog(container: Element, name = 'Open') {
  fireEvent.click(screen.getByRole('button', { name }));
  return getDialogEl(container);
}

describe('Dialog', () => {
  it('renders a default "Open" trigger when none is provided', () => {
    render(<Dialog>content</Dialog>);

    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('renders a custom trigger and wires it to open the dialog', () => {
    const onOpen = jest.fn();
    const { container } = render(
      <Dialog trigger={<button>Launch</button>} onOpen={onOpen}>
        content
      </Dialog>,
    );

    const dialog = getDialogEl(container);
    expect(dialog).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute('open');
  });

  it('renders the title and children', () => {
    render(
      <Dialog title="My Title">
        <p>Body content</p>
      </Dialog>,
    );

    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('renders a close (X) button by default that cancels and closes without firing onClose', () => {
    const onCancel = jest.fn();
    const onClose = jest.fn();
    const { container } = render(
      <Dialog onCancel={onCancel} onClose={onClose}>
        content
      </Dialog>,
    );

    const dialog = openDialog(container);
    const closeButton = dialog.querySelector('button') as HTMLButtonElement;
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).not.toHaveAttribute('open');
  });

  it('omits the close (X) button when disableClose is set', () => {
    const { container } = render(<Dialog disableClose>content</Dialog>);

    const dialog = openDialog(container);
    expect(dialog.querySelector('button')).toBeNull();
  });

  it('exposes close() via context that fires onClose and closes the dialog with a value', () => {
    const onClose = jest.fn();

    function Body() {
      const { close } = useDialog();
      return <button onClick={() => close('confirmed')}>Confirm</button>;
    }

    const { container } = render(
      <Dialog onClose={onClose}>
        <Body />
      </Dialog>,
    );

    const dialog = openDialog(container);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute('open');
    expect(dialog.returnValue).toBe('confirmed');
  });

  it('merges a caller className onto the base skin classes, and applies contentClassName to the inner wrapper', () => {
    const { container } = render(
      <Dialog className="custom-outer" contentClassName="custom-inner">
        content
      </Dialog>,
    );

    const dialog = getDialogEl(container);
    expect(dialog.className).toContain('custom-outer');
    expect(dialog.className).toContain('rounded');

    const inner = dialog.querySelector('div');
    expect(inner?.className).toContain('custom-inner');
  });
});

// Coverage for the controlled `open` signal: previously declared on
// DialogProps but never read anywhere in this component — a caller
// opening the dialog as a side effect of something else entirely (no
// visible trigger button of its own) had no way to drive it. See the
// comments above the two `useEffect`s in Dialog.tsx for the sync design.
describe('Dialog — controlled open signal', () => {
  it('leaves the existing trigger-click behavior unchanged when `open` is omitted', () => {
    const { container } = render(<Dialog trigger={<button>Launch</button>}>content</Dialog>);
    const dialog = getDialogEl(container);
    expect(dialog).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    expect(dialog).toHaveAttribute('open');
  });

  it('renders no default trigger when `open` is provided and no trigger is given', () => {
    const open = signal(false);
    render(<Dialog open={open}>content</Dialog>);

    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('opens the dialog when open.value flips to true externally', () => {
    const open = signal(false);
    const { container } = render(<Dialog open={open}>content</Dialog>);
    const dialog = getDialogEl(container);
    expect(dialog).not.toHaveAttribute('open');

    act(() => {
      open.value = true;
    });

    expect(dialog).toHaveAttribute('open');
  });

  it('closes the dialog when open.value flips to false externally', () => {
    const open = signal(true);
    const { container } = render(<Dialog open={open}>content</Dialog>);
    const dialog = getDialogEl(container);
    expect(dialog).toHaveAttribute('open');

    act(() => {
      open.value = false;
    });

    expect(dialog).not.toHaveAttribute('open');
  });

  it('syncs open.value back to false when the dialog is dismissed natively (e.g. Escape)', () => {
    const open = signal(true);
    const { container } = render(<Dialog open={open}>content</Dialog>);
    const dialog = getDialogEl(container);

    // A real native dismissal (Escape) has already closed the dialog
    // (removed the `open` attribute) by the time the `close` event fires —
    // replicate that ordering here rather than merely dispatching the
    // event, so this exercises the same post-close state the component's
    // own listener actually observes.
    act(() => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });

    expect(open.value).toBe(false);
  });

  it('the X button still fires onCancel and syncs open.value back to false', () => {
    const onCancel = jest.fn();
    const open = signal(true);
    const { container } = render(
      <Dialog open={open} onCancel={onCancel}>
        content
      </Dialog>,
    );
    const dialog = getDialogEl(container);
    const closeButton = dialog.querySelector('button') as HTMLButtonElement;

    fireEvent.click(closeButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute('open');
    expect(open.value).toBe(false);
  });

  it("does not call close() again when reacting to the dialog's own native close event", () => {
    const open = signal(true);
    const { container } = render(<Dialog open={open}>content</Dialog>);
    const dialog = getDialogEl(container);
    const closeSpy = jest.fn();
    const originalClose = dialog.close.bind(dialog);
    dialog.close = (...args: Parameters<typeof originalClose>) => {
      closeSpy();
      originalClose(...args);
    };

    // Simulate the browser having already closed the dialog natively
    // (Escape) without going through this component's own `.close()` —
    // asserting the spy afterward proves the `open`-sync effect's
    // `dialogEl.open` guard prevents a redundant second close() call.
    act(() => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });

    expect(closeSpy).not.toHaveBeenCalled();
  });
});
