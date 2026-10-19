import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { DensityToggle, type Density } from '@/components/ui/density-toggle';

function ControlledDensityToggle({ initial = 'compact' as Density }) {
  const [value, setValue] = useState<Density>(initial);
  return <DensityToggle value={value} onChange={setValue} />;
}

describe('DensityToggle', () => {
  it('renders both options as radio items', () => {
    render(<ControlledDensityToggle />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Roomy' })).toBeInTheDocument();
  });

  it('reflects the given value as checked', () => {
    render(<ControlledDensityToggle initial="roomy" />);
    expect(screen.getByRole('radio', { name: 'Roomy' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Compact' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange with the newly selected value when clicked', () => {
    const onChange = jest.fn();
    render(<DensityToggle value="compact" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }));
    expect(onChange).toHaveBeenCalledWith('roomy');
  });

  it('updates the checked item once the controlling value changes', () => {
    render(<ControlledDensityToggle />);
    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }));
    expect(screen.getByRole('radio', { name: 'Roomy' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Compact' })).toHaveAttribute('aria-checked', 'false');
  });
});
