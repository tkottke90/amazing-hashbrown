import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { ScaledCostInput } from '@/components/ui/scaled-cost-input';
import type { Scale } from '@/components/ui/scale-toggle';

function ControlledScaledCostInput({
  initialPer1kValue,
  initialScale,
}: {
  initialPer1kValue: number;
  initialScale: Scale;
}) {
  const [per1kValue, setPer1kValue] = useState(initialPer1kValue);
  const [scale, setScale] = useState<Scale>(initialScale);
  return (
    <ScaledCostInput
      id="cost"
      label="Input cost"
      per1kValue={per1kValue}
      scale={scale}
      onChange={(v, s) => {
        setPer1kValue(v);
        setScale(s);
      }}
    />
  );
}

describe('ScaledCostInput', () => {
  it('displays the per-1k value directly when scale is 1k', () => {
    render(<ControlledScaledCostInput initialPer1kValue={0.0014} initialScale="1k" />);
    expect(screen.getByLabelText('Input cost')).toHaveValue(0.0014);
  });

  it('displays the converted value when scale is 1M (edit-mode restore)', () => {
    render(<ControlledScaledCostInput initialPer1kValue={0.0014} initialScale="1M" />);
    expect(screen.getByLabelText('Input cost')).toHaveValue(1.4);
  });

  it('toggling 1k -> 1M converts the display without changing the underlying value', () => {
    render(<ControlledScaledCostInput initialPer1kValue={0.0014} initialScale="1k" />);
    fireEvent.click(screen.getByRole('radio', { name: '1M' }));
    expect(screen.getByLabelText('Input cost')).toHaveValue(1.4);
  });

  it('toggling 1M -> 1k converts the display back', () => {
    render(<ControlledScaledCostInput initialPer1kValue={0.0044} initialScale="1M" />);
    fireEvent.click(screen.getByRole('radio', { name: '1k' }));
    expect(screen.getByLabelText('Input cost')).toHaveValue(0.0044);
  });

  it('editing the number while scale is 1M converts back to per-1k on emit', () => {
    const onChange = jest.fn();
    render(
      <ScaledCostInput id="cost" label="Input cost" per1kValue={0} scale="1M" onChange={onChange} />,
    );
    fireEvent.input(screen.getByLabelText('Input cost'), { target: { value: '2.8' } });
    expect(onChange).toHaveBeenCalledWith(0.0028, '1M');
  });
});
