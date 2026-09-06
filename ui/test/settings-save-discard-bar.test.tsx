import { fireEvent, render, screen } from '@testing-library/preact';
import { SaveDiscardBar } from '@/pages/settings/save-discard-bar';

describe('SaveDiscardBar', () => {
  it('renders nothing when not dirty', () => {
    const { container } = render(
      <SaveDiscardBar isDirty={false} isSaving={false} onSave={jest.fn()} onDiscard={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the unsaved-changes label and both buttons when dirty', () => {
    render(
      <SaveDiscardBar isDirty={true} isSaving={false} onSave={jest.fn()} onDiscard={jest.fn()} />,
    );
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('calls onDiscard when Discard is clicked', () => {
    const onDiscard = jest.fn();
    render(
      <SaveDiscardBar isDirty={true} isSaving={false} onSave={jest.fn()} onDiscard={onDiscard} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('calls onSave when Save changes is clicked', () => {
    const onSave = jest.fn();
    render(
      <SaveDiscardBar isDirty={true} isSaving={false} onSave={onSave} onDiscard={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while saving', () => {
    render(
      <SaveDiscardBar isDirty={true} isSaving={true} onSave={jest.fn()} onDiscard={jest.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
  });

  it('renders with the elevated/tinted visual treatment', () => {
    const { container } = render(
      <SaveDiscardBar isDirty={true} isSaving={false} onSave={jest.fn()} onDiscard={jest.fn()} />,
    );
    const bar = container.firstElementChild;
    expect(bar).not.toBeNull();
    expect(bar?.className).toEqual(expect.stringContaining('bg-primary/10'));
    expect(bar?.className).toEqual(expect.stringContaining('border-primary/30'));
  });
});
