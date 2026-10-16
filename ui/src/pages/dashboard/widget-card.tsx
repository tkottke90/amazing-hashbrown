import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';

interface WidgetCardProps {
  title: string;
  subtitle?: string;
  children: ComponentChildren;
  className?: string;
}

export function WidgetCard({ title, subtitle, children, className }: WidgetCardProps) {
  return (
    <div
      data-testid="widget-card"
      className={cn('flex flex-col gap-2 rounded-md border border-border bg-card p-4', className)}
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
