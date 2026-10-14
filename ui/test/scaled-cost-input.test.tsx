import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { ScaledCostInput } from '@/components/ui/scaled-cost-input';
import type { Scale } from '@/components/ui/scale-toggle';

function ControlledScaledCostInput({
  initialPerMillionValue,
  initialScale,
}: {
  initialPerMillionValue: number;
  initialScale: Scale;
}) {
  const [perMillionValue, setPerMillionValue] = useState(initialPerMillionValue);
  const [scale, setScale] = useState<Scale>(initialScale);
  return (
    <ScaledCostInput
      id="cost"
      label="Input cost"
      perMillionValue={perMillionValue}
      scale={scale}
      onChange={(v, s) => {
        setPerMillionValue(v);
        setScale(s);
      }}
    />
  );
}

describe('ScaledCostInput', () => {
  it('displays the per-million value directly when scale is 1M', () => {
    render(<ControlledScaledCostInput initialPerMillionValue={1400} initialScale="1M" />);
    expect(screen.getByLabelText('Input cost')).toHaveValue(1400);
  });

  it('displays the converted value when scale is 1k (edit-mode restore)', () => {
    render(<ControlledScaledCostInput initialPerMillionValue={1400} initialScale="1k" />);
    expect(screen.getByLabelText('Input cost')).toHaveValue(1.4);
  });

  it('toggling 1M -> 1k converts the display without changing the underlying value', () => {
    render(<ControlledScaledCostInput initialPerMillionValue={1400} initialScale="1M" />);
    fireEvent.click(screen.getByRole('radio', { name: '1k' }));
    expect(screen.getByLabelText('Input cost')).toHaveValue(1.4);
  });

  it('toggling 1k -> 1M converts the display back', () => {
    render(<ControlledScaledCostInput initialPerMillionValue={4400} initialScale="1k" />);
    fireEvent.click(screen.getByRole('radio', { name: '1M' }));
    expect(screen.getByLabelText('Input cost')).toHaveValue(4400);
  });

  it('editing the number while scale is 1k converts to per-million on emit', () => {
    const onChange = jest.fn();
    render(
      <ScaledCostInput
        id="cost"
        label="Input cost"
        perMillionValue={0}
        scale="1k"
        onChange={onChange}
      />,
    );
    fireEvent.input(screen.getByLabelText('Input cost'), { target: { value: '2.8' } });
    expect(onChange).toHaveBeenCalledWith(2800, '1k');
  });

  it('typing the same price at either scale converges on the same persisted value', () => {
    const onChangeAt1M = jest.fn();
    const onChangeAt1k = jest.fn();
    render(
      <ScaledCostInput
        id="cost-1m"
        label="Input cost"
        perMillionValue={0}
        scale="1M"
        onChange={onChangeAt1M}
      />,
    );
    render(
      <ScaledCostInput
        id="cost-1k"
        label="Input cost 2"
        perMillionValue={0}
        scale="1k"
        onChange={onChangeAt1k}
      />,
    );
    fireEvent.input(screen.getByLabelText('Input cost'), { target: { value: '1400' } });
    fireEvent.input(screen.getByLabelText('Input cost 2'), { target: { value: '1.4' } });
    expect(onChangeAt1M).toHaveBeenCalledWith(1400, '1M');
    expect(onChangeAt1k).toHaveBeenCalledWith(1400, '1k');
  });
});
