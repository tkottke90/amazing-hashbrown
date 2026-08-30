import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { ScaleToggle, type Scale } from '@/components/ui/scale-toggle';

function ControlledScaleToggle({ initial = '1k' as Scale }) {
  const [value, setValue] = useState<Scale>(initial);
  return <ScaleToggle value={value} onChange={setValue} />;
}

describe('ScaleToggle', () => {
  it('renders both options as radio items', () => {
    render(<ControlledScaleToggle />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: '1k' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1M' })).toBeInTheDocument();
  });

  it('reflects the given value as checked', () => {
    render(<ControlledScaleToggle initial="1M" />);
    expect(screen.getByRole('radio', { name: '1M' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '1k' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange with the newly selected value when clicked', () => {
    const onChange = jest.fn();
    render(<ScaleToggle value="1k" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '1M' }));
    expect(onChange).toHaveBeenCalledWith('1M');
  });

  it('updates the checked item once the controlling value changes', () => {
    render(<ControlledScaleToggle />);
    fireEvent.click(screen.getByRole('radio', { name: '1M' }));
    expect(screen.getByRole('radio', { name: '1M' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '1k' })).toHaveAttribute('aria-checked', 'false');
  });
});
