import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const SCALE_OPTIONS = [
  { value: '1k', label: '1k' },
  { value: '1M', label: '1M' },
] as const;

export type Scale = '1k' | '1M';

// A two-option exclusive control for choosing between per-1k and per-1M
// token pricing, rendered as a segmented button pair rather than Radix's
// default radio-dot appearance — selection is conveyed by background/text
// color on each segment, matching button.tsx's `size="sm"` visual weight.
function ScaleToggle({
  value,
  onChange,
  className,
  ...props
}: {
  value: Scale;
  onChange: (value: Scale) => void;
  className?: string;
} & Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Root>,
  'value' | 'onValueChange' | 'className' | 'onChange'
>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="scale-toggle"
      value={value}
      onValueChange={(v) => onChange(v as Scale)}
      className={cn(
        'inline-flex h-7 items-center gap-0.5 rounded-[min(var(--radius-md),12px)] border border-input bg-background p-0.5',
        className,
      )}
      {...props}
    >
      {SCALE_OPTIONS.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          data-slot="scale-toggle-item"
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

export { ScaleToggle };
