import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { ToolStatusFilter, type ToolStatusFilterValue } from '@/components/ui/tool-status-filter';

function ControlledToolStatusFilter({ initial = 'enabled' as ToolStatusFilterValue }) {
  const [value, setValue] = useState<ToolStatusFilterValue>(initial);
  return <ToolStatusFilter value={value} onChange={setValue} />;
}

describe('ToolStatusFilter', () => {
  it('renders all three options as radio items', () => {
    render(<ControlledToolStatusFilter />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Enabled' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Disabled' })).toBeInTheDocument();
  });

  it('reflects the given value as checked', () => {
    render(<ControlledToolStatusFilter initial="disabled" />);
    expect(screen.getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange with the newly selected value when clicked', () => {
    const onChange = jest.fn();
    render(<ToolStatusFilter value="enabled" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('updates the checked item once the controlling value changes', () => {
    render(<ControlledToolStatusFilter />);
    fireEvent.click(screen.getByRole('radio', { name: 'Disabled' }));
    expect(screen.getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'false');
  });
});
