import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { WidgetCard } from './widget-card';
import { WidgetDrawer } from './widget-drawer';

interface WidgetErrorCardProps {
  result: Extract<WidgetLoadResult, { status: 'error' }>;
  onChanged: () => void;
}

// Renders a widget file that failed to parse — e.g. malformed YAML
// frontmatter. Per the design doc's D8/D9, a broken file never fails the
// whole dashboard load; it surfaces here with a path to fix it instead.
// "Edit raw file" opens the same edit drawer as a healthy widget's Edit
// button — its entry rules land it on the Raw tab automatically with Form
// unreachable, since there's nothing valid to show in Form.
export function WidgetErrorCard({ result, onChanged }: WidgetErrorCardProps) {
  return (
    // widget-card.tsx stays type-agnostic (no error-specific prop) per the
    // design doc's D13 — this wrapper adds the distinguishing testid on top
    // of the shell's own "widget-card" one, rather than threading an
    // error-only prop into the shared component.
    <div data-testid="widget-error-card">
      <WidgetCard title="Unable to load this widget">
        <p className="text-sm text-destructive">{result.error}</p>
        <WidgetDrawer
          mode="edit"
          target={result}
          onSaved={onChanged}
          trigger={
            <button
              type="button"
              data-testid="widget-edit-raw-button"
              className="self-start text-sm text-primary underline-offset-4 hover:underline"
            >
              Edit raw file
            </button>
          }
        />
      </WidgetCard>
    </div>
  );
}
