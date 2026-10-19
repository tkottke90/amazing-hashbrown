import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const DENSITY_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'roomy', label: 'Roomy' },
] as const;

export type Density = 'compact' | 'roomy';

// Density (see GLOSSARY.md) — a two-option exclusive control, same
// segmented-button-pair structure as scale-toggle.tsx's ScaleToggle (kept
// as its own component rather than widening that one's props for a
// one-off reuse — the two controls have unrelated option sets).
function DensityToggle({
  value,
  onChange,
  className,
  ...props
}: {
  value: Density;
  onChange: (value: Density) => void;
  className?: string;
} & Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Root>,
  'value' | 'onValueChange' | 'className' | 'onChange'
>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="density-toggle"
      value={value}
      onValueChange={(v) => onChange(v as Density)}
      className={cn(
        'inline-flex h-7 items-center gap-0.5 rounded-[min(var(--radius-md),12px)] border border-input bg-background p-0.5',
        className,
      )}
      {...props}
    >
      {DENSITY_OPTIONS.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          data-slot="density-toggle-item"
          data-testid={`density-toggle-${option.value}`}
          className={cn(
            'h-6 rounded-[min(var(--radius-md),10px)] px-2 text-[0.8rem] font-medium whitespace-nowrap outline-none transition-colors',
            'text-muted-foreground hover:text-foreground',
            'data-checked:bg-primary data-checked:text-primary-foreground data-checked:hover:text-primary-foreground',
            'focus-visible:ring-3 focus-visible:ring-ring/50',
          )}
        >
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

export { DensityToggle };
