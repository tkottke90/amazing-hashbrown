import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScaleToggle, type Scale } from '@/components/ui/scale-toggle';

const SCALE_FACTOR: Record<Scale, number> = { '1k': 1, '1M': 1000 };

// Shared by ScaledCostInput and cost-rates-panel.tsx's list summary line, so
// both always agree on what a given per-1k value looks like under a given
// scale.
export function scaledDisplayValue(per1kValue: number, scale: Scale): number {
  return per1kValue * SCALE_FACTOR[scale];
}

function displayToPer1k(displayValue: number, scale: Scale): number {
  return displayValue / SCALE_FACTOR[scale];
}

interface ScaledCostInputProps {
  id: string;
  label: string;
  per1kValue: number;
  scale: Scale;
  onChange: (per1kValue: number, scale: Scale) => void;
}

// A number input + 1k/1M unit toggle. Always controlled by the normalized
// per-1k value from the parent; the displayed number is derived from it and
// the current scale, never stored independently except while the user is
// mid-keystroke (see the local `displayText` buffer below).
function ScaledCostInput({ id, label, per1kValue, scale, onChange }: ScaledCostInputProps) {
  const [displayText, setDisplayText] = React.useState(() =>
    String(scaledDisplayValue(per1kValue, scale)),
  );

  // Re-derive the displayed text whenever the unit changes — covers both
  // the ScaleToggle being flipped and an edit-mode form mounting pre-set to
  // a stored scale. Deliberately not keyed on per1kValue too: that would
  // fight the user's own in-progress typing, since handleNumberInput below
  // already keeps displayText in sync with whatever per1kValue it emits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    setDisplayText(String(scaledDisplayValue(per1kValue, scale)));
  }, [scale]);

  function handleNumberInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    setDisplayText(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && !Number.isNaN(parsed)) {
      onChange(displayToPer1k(parsed, scale), scale);
    }
  }

  function handleScaleChange(newScale: Scale) {
    setDisplayText(String(scaledDisplayValue(per1kValue, newScale)));
    onChange(per1kValue, newScale);
  }

  return (
    <div
      className="grid grid-cols-3 gap-1.5"
      style={{ gridTemplateAreas: `"label label label" "input input toggle"` }}
    >
      <Label htmlFor={id} style={{ gridArea: 'label' }}>
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step="any"
        min="0"
        style={{ gridArea: 'input' }}
        value={displayText}
        onInput={handleNumberInput}
      />
      <div style={{ gridArea: 'toggle' }} className="flex items-center">
        <ScaleToggle value={scale} onChange={handleScaleChange} />
      </div>
    </div>
  );
}

export { ScaledCostInput };
export type { ScaledCostInputProps };
