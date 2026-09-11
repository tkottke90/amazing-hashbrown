import { fireEvent, render, screen } from '@testing-library/preact';
import { KeyValueList } from '@/components/key-value-list';

describe('KeyValueList', () => {
  it('renders one row per existing entry', () => {
    render(
      <KeyValueList
        value={{ API_KEY: 'abc', DEBUG: 'true' }}
        onChange={jest.fn()}
        addLabel="Add env var"
      />,
    );
    expect(screen.getByDisplayValue('API_KEY')).toBeInTheDocument();
    expect(screen.getByDisplayValue('DEBUG')).toBeInTheDocument();
  });

  it('adding a row does not call onChange until it has a key', () => {
    const onChange = jest.fn();
    render(<KeyValueList value={{}} onChange={onChange} addLabel="Add env var" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add env var' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Key 1')).toBeInTheDocument();
  });

  it('typing a key and value emits the updated record', () => {
    const onChange = jest.fn();
    render(<KeyValueList value={{}} onChange={onChange} addLabel="Add env var" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add env var' }));

    fireEvent.input(screen.getByLabelText('Key 1'), { target: { value: 'API_KEY' } });
    fireEvent.input(screen.getByLabelText('Value 1'), { target: { value: 'secret' } });

    expect(onChange).toHaveBeenLastCalledWith({ API_KEY: 'secret' });
  });

  it('removing a row drops it from the emitted record', () => {
    const onChange = jest.fn();
    render(
      <KeyValueList
        value={{ API_KEY: 'abc', DEBUG: 'true' }}
        onChange={onChange}
        addLabel="Add env var"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove API_KEY' }));
    expect(onChange).toHaveBeenCalledWith({ DEBUG: 'true' });
  });
});
