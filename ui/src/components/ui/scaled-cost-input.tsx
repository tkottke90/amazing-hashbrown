import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScaleToggle, type Scale } from '@/components/ui/scale-toggle';

// How many tokens a "1k"/"1M" display value actually covers, relative to
// the per-million unit this component (and ModelConfigSchema) always
// stores — e.g. "$1.4 per 1k tokens" is the same price as "$1400 per 1M
// tokens", so displayToPerMillion(1.4, '1k') === 1400.
const SCALE_FACTOR: Record<Scale, number> = { '1k': 1000, '1M': 1 };

// Shared by ScaledCostInput and model-settings-panel.tsx's list summary
// line, so both always agree on what a given per-million value looks like
// under a given display scale.
export function scaledDisplayValue(perMillionValue: number, scale: Scale): number {
  return perMillionValue / SCALE_FACTOR[scale];
}

function displayToPerMillion(displayValue: number, scale: Scale): number {
  return displayValue * SCALE_FACTOR[scale];
}

interface ScaledCostInputProps {
  id: string;
  label: string;
  perMillionValue: number;
  scale: Scale;
  onChange: (perMillionValue: number, scale: Scale) => void;
}

// A number input + 1k/1M unit toggle. Always controlled by the normalized
// per-million value from the parent; the displayed number is derived from
// it and the current scale, never stored independently except while the
// user is mid-keystroke (see the local `displayText` buffer below). The
// scale itself is purely an input-time convenience — nothing about it is
// persisted (see docs/superpowers/specs/2026-10-14-per-model-sampling-pricing-config-design.md
// §6): typing the same price at either scale produces the same emitted value.
function ScaledCostInput({ id, label, perMillionValue, scale, onChange }: ScaledCostInputProps) {
  const [displayText, setDisplayText] = React.useState(() =>
    String(scaledDisplayValue(perMillionValue, scale)),
  );

  // Re-derive the displayed text whenever the unit changes — covers both
  // the ScaleToggle being flipped and an edit-mode form mounting pre-set to
  // a stored scale. Deliberately not keyed on perMillionValue too: that
  // would fight the user's own in-progress typing, since handleNumberInput
  // below already keeps displayText in sync with whatever value it emits.
  React.useEffect(() => {
    setDisplayText(String(scaledDisplayValue(perMillionValue, scale)));
  }, [scale]);

  function handleNumberInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    setDisplayText(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && !Number.isNaN(parsed)) {
      onChange(displayToPerMillion(parsed, scale), scale);
    }
  }

  function handleScaleChange(newScale: Scale) {
    setDisplayText(String(scaledDisplayValue(perMillionValue, newScale)));
    onChange(perMillionValue, newScale);
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
