import { fireEvent, render, screen } from '@testing-library/preact';
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
