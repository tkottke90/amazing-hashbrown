import { useSignal } from '@preact/signals';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import type { JSX } from 'preact';
import type { DashboardWidget } from '@tkottke90/amazing-hashbrown-widgets/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  createWidget,
  updateWidget,
  updateWidgetRaw,
  DEFAULT_DASHBOARD_ID,
} from '@/services/dashboard-api';

export type WidgetDrawerMode = 'add' | 'edit' | 'raw';

interface WidgetDrawerProps {
  mode: WidgetDrawerMode;
  /** Required for `mode: 'edit'`. */
  widget?: DashboardWidget;
  /** Required for `mode: 'raw'`. */
  rawId?: string;
  /** Required for `mode: 'raw'`. */
  rawContent?: string;
  onSaved: () => void;
  trigger: JSX.Element;
}

const DRAWER_TITLE: Record<WidgetDrawerMode, string> = {
  add: 'Add widget',
  edit: 'Edit widget',
  raw: 'Edit raw file',
};

// Add/Edit/Raw forms for a Markdown widget — the only type this slice
// supports creating or editing (see the design doc's D10). Mirrors
// mcp-server-drawer.tsx's Drawer/useDialog structure: a wrapper that owns
// the Drawer + trigger, and a form component (the Drawer's child) that
// calls useDialog() to close itself after a successful save.
export function WidgetDrawer({
  mode,
  widget,
  rawId,
  rawContent,
  onSaved,
  trigger,
}: WidgetDrawerProps) {
  return (
    <Drawer
      title={DRAWER_TITLE[mode]}
      side="right"
      className="w-[90vw]! sm:w-lg! sm:max-w-[90vw]! py-4"
      trigger={trigger}
    >
      <WidgetDrawerForm
        mode={mode}
        widget={widget}
        rawId={rawId}
        rawContent={rawContent}
        onSaved={onSaved}
      />
    </Drawer>
  );
}

function WidgetDrawerForm({
  mode,
  widget,
  rawId,
  rawContent,
  onSaved,
}: Omit<WidgetDrawerProps, 'trigger'>) {
  const { close } = useDialog();
  // Every drawer instance stays mounted simultaneously (one per card plus
  // the Add button's), so field ids need a per-instance suffix.
  const instanceKey =
    mode === 'edit' && widget
      ? `edit-${widget.id}`
      : mode === 'raw' && rawId
        ? `raw-${rawId}`
        : 'add';

  const title = useSignal(widget?.title ?? '');
  const subtitle = useSignal(widget?.subtitle ?? '');
  const content = useSignal(widget?.content ?? '');
  const raw = useSignal(rawContent ?? '');
  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    try {
      if (mode === 'add') {
        await createWidget(DEFAULT_DASHBOARD_ID, {
          title: title.value.trim(),
          subtitle: subtitle.value.trim() || undefined,
          content: content.value,
        });
      } else if (mode === 'edit' && widget) {
        await updateWidget(DEFAULT_DASHBOARD_ID, widget.id, {
          title: title.value.trim(),
          subtitle: subtitle.value.trim() || undefined,
          content: content.value,
        });
      } else if (mode === 'raw' && rawId) {
        await updateWidgetRaw(DEFAULT_DASHBOARD_ID, rawId, raw.value);
      }
      onSaved();
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save widget';
    } finally {
      isSaving.value = false;
    }
  }

  return (
    <form data-testid="widget-drawer-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {mode === 'raw' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${instanceKey}-raw`}>Raw file content</Label>
          <Textarea
            id={`${instanceKey}-raw`}
            rows={16}
            value={raw.value}
            onInput={(e) => (raw.value = (e.target as HTMLTextAreaElement).value)}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${instanceKey}-title`}>Title</Label>
            <Input
              id={`${instanceKey}-title`}
              value={title.value}
              onInput={(e) => (title.value = (e.target as HTMLInputElement).value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${instanceKey}-subtitle`}>Subtitle</Label>
            <Input
              id={`${instanceKey}-subtitle`}
              value={subtitle.value}
              onInput={(e) => (subtitle.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${instanceKey}-content`}>Content (Markdown)</Label>
            <Textarea
              id={`${instanceKey}-content`}
              rows={10}
              value={content.value}
              onInput={(e) => (content.value = (e.target as HTMLTextAreaElement).value)}
            />
          </div>
        </>
      )}

      {saveError.value && <p className="text-sm text-destructive">{saveError.value}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving.value}>
          Save
        </Button>
      </div>
    </form>
  );
}
