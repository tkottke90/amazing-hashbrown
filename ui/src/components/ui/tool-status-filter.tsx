import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const TOOL_STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
] as const;

export type ToolStatusFilterValue = 'all' | 'enabled' | 'disabled';

// A three-option exclusive control, same segmented-button structure as
// scale-toggle.tsx/density-toggle.tsx (kept as its own component rather than
// widening either of those for a one-off reuse — the three controls have
// unrelated option sets). Buckets tools purely by their resolved `enabled`
// field, including Always-On Tools and Skill-Gated/Skill-Scoped Tools — see
// GLOSSARY.md's "Always-On Tool" and ADR-0073 for why there's no
// category-based exception here.
function ToolStatusFilter({
  value,
  onChange,
  className,
  ...props
}: {
  value: ToolStatusFilterValue;
  onChange: (value: ToolStatusFilterValue) => void;
  className?: string;
} & Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Root>,
  'value' | 'onValueChange' | 'className' | 'onChange'
>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="tool-status-filter"
      value={value}
      onValueChange={(v) => onChange(v as ToolStatusFilterValue)}
      className={cn(
        'inline-flex h-7 items-center gap-0.5 rounded-[min(var(--radius-md),12px)] border border-input bg-background p-0.5',
        className,
      )}
      {...props}
    >
      {TOOL_STATUS_OPTIONS.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          data-slot="tool-status-filter-item"
          data-testid={`tool-status-filter-${option.value}`}
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

export { ToolStatusFilter };
