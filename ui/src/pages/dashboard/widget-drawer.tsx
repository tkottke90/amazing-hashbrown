import { useSignal, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import type { EditorView } from '@codemirror/view';
import type { JSX } from 'preact';
import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import {
  createWidget,
  updateWidget,
  updateWidgetRaw,
  validateWidgetRaw,
  DEFAULT_DASHBOARD_ID,
  type ValidateWidgetResult,
} from '@/services/dashboard-api';
import { serializeWidgetFile } from './serialize-widget-file';

export type WidgetDrawerMode = 'add' | 'edit';

export type WidgetDrawerProps =
  | { mode: 'add'; onSaved: () => void; trigger: JSX.Element }
  | { mode: 'edit'; target: WidgetLoadResult; onSaved: () => void; trigger: JSX.Element };

// Add/Edit for a Markdown widget — the only type this slice supports
// creating or editing. Edit mode adds a Form/Raw tab toggle: Form is the
// structured title/subtitle/content fields (unchanged), Raw is the widget's
// entire file (frontmatter + body) edited directly via CodeMirror, gated
// behind manual validation (see the design doc's validation state machine).
// Raw also replaces the old standalone raw-recovery drawer — a widget whose
// file failed to parse opens straight onto Raw with Form unreachable.
export function WidgetDrawer(props: WidgetDrawerProps) {
  // Re-open counter, same pattern as mcp-server-drawer.tsx: dialog children
  // stay mounted between opens, so transient state needs an explicit reset.
  const openCount = useSignal(0);

  return (
    <Drawer
      title={props.mode === 'add' ? 'Add widget' : 'Edit widget'}
      side="right"
      className="w-[90vw]! sm:w-lg! sm:max-w-[90vw]! py-4"
      trigger={props.trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <WidgetDrawerForm {...props} openCount={openCount} />
    </Drawer>
  );
}

type Tab = 'form' | 'raw';

interface LastChecked {
  text: string;
  result: ValidateWidgetResult;
}

function WidgetDrawerForm(props: WidgetDrawerProps & { openCount: Signal<number> }) {
  const { mode, onSaved, openCount } = props;
  const target = props.mode === 'edit' ? props.target : undefined;
  const { close } = useDialog();

  const initialWidget = target?.status === 'ok' ? target.widget : undefined;
  const loadFailed = target?.status === 'error';
  const widgetId = target ? (target.status === 'ok' ? target.widget.id : target.id) : undefined;
  const instanceKey = mode === 'edit' && widgetId ? `edit-${widgetId}` : 'add';

  const title = useSignal(initialWidget?.title ?? '');
  const subtitle = useSignal(initialWidget?.subtitle ?? '');
  const content = useSignal(initialWidget?.content ?? '');
  const order = useSignal(initialWidget?.order ?? 0);

  function initialRawText(): string {
    if (!target) return '';
    if (target.status === 'error') return target.raw;
    return serializeWidgetFile({
      title: target.widget.title,
      subtitle: target.widget.subtitle,
      type: 'markdown',
      order: target.widget.order,
      content: target.widget.content,
    });
  }

  const tab = useSignal<Tab>(loadFailed ? 'raw' : 'form');
  const rawText = useSignal(initialRawText());
  const rawGeneration = useSignal(0);
  const rawDirty = useSignal(false);
  const rawViewRef = useRef<EditorView | null>(null);
  const lastChecked = useSignal<LastChecked | undefined>(undefined);
  const isValidating = useSignal(false);

  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  // Fires on mount and again on every reopen — resets both the seeded form
  // fields and every bit of Raw/validation state, so a widget edited then
  // abandoned mid-Raw-edit doesn't leak into the next open.
  const openedAt = openCount.value;
  useEffect(() => {
    if (mode !== 'edit') return;
    title.value = initialWidget?.title ?? '';
    subtitle.value = initialWidget?.subtitle ?? '';
    content.value = initialWidget?.content ?? '';
    order.value = initialWidget?.order ?? 0;
    rawText.value = initialRawText();
    rawGeneration.value++;
    rawDirty.value = false;
    lastChecked.value = undefined;
    tab.value = loadFailed ? 'raw' : 'form';
    saveError.value = null;
  }, [openedAt]);

  function readRawText(): string {
    return rawViewRef.current?.state.doc.toString() ?? rawText.value;
  }

  async function runValidate(text: string): Promise<boolean> {
    isValidating.value = true;
    try {
      const result = await validateWidgetRaw({
        dashboardId: DEFAULT_DASHBOARD_ID,
        widgetId: widgetId as string,
        raw: text,
      });
      lastChecked.value = { text, result };
      rawDirty.value = false;
      return result.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to validate';
      lastChecked.value = { text, result: { ok: false, error: message } };
      rawDirty.value = false;
      return false;
    } finally {
      isValidating.value = false;
    }
  }

  // Only a never-checked text fires a real request; an exact cache hit
  // (same text as last time, whatever the outcome) reuses it for free;
  // anything else (edited since) stays locked pending an explicit Validate.
  async function ensureValidated(): Promise<boolean> {
    const currentText = readRawText();
    const checked = lastChecked.value;
    if (checked === undefined) return runValidate(currentText);
    if (checked.text === currentText) return checked.result.ok;
    return false;
  }

  async function handleValidateClick() {
    const currentText = readRawText();
    if (lastChecked.value && lastChecked.value.text === currentText) return;
    await runValidate(currentText);
  }

  function enterRaw() {
    if (tab.value === 'raw') return;
    rawText.value = serializeWidgetFile({
      title: title.value.trim(),
      subtitle: subtitle.value.trim() || undefined,
      type: 'markdown',
      order: order.value,
      content: content.value,
    });
    rawGeneration.value++;
    rawDirty.value = false;
    lastChecked.value = undefined;
    tab.value = 'raw';
  }

  async function handleFormTabClick() {
    if (tab.value === 'form') return;
    if (!(await ensureValidated())) return;
    const checked = lastChecked.value;
    if (checked?.result.ok) {
      title.value = checked.result.widget.title;
      subtitle.value = checked.result.widget.subtitle ?? '';
      content.value = checked.result.widget.content;
      order.value = checked.result.widget.order;
    }
    tab.value = 'form';
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    saveError.value = null;

    if (mode === 'edit' && tab.value === 'raw') {
      if (!(await ensureValidated())) return;
      isSaving.value = true;
      try {
        await updateWidgetRaw(DEFAULT_DASHBOARD_ID, widgetId as string, readRawText());
        onSaved();
        close();
      } catch (err) {
        saveError.value = err instanceof Error ? err.message : 'Failed to save widget';
      } finally {
        isSaving.value = false;
      }
      return;
    }

    isSaving.value = true;
    try {
      if (mode === 'add') {
        await createWidget(DEFAULT_DASHBOARD_ID, {
          title: title.value.trim(),
          subtitle: subtitle.value.trim() || undefined,
          content: content.value,
        });
      } else if (widgetId) {
        await updateWidget(DEFAULT_DASHBOARD_ID, widgetId, {
          title: title.value.trim(),
          subtitle: subtitle.value.trim() || undefined,
          content: content.value,
        });
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
      {mode === 'edit' && (
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={tab.value === 'form' ? 'default' : 'outline'}
            data-testid="widget-drawer-tab-form"
            onClick={() => void handleFormTabClick()}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tab.value === 'raw' ? 'default' : 'outline'}
            data-testid="widget-drawer-tab-raw"
            onClick={enterRaw}
          >
            Raw
          </Button>
        </div>
      )}

      {tab.value === 'form' ? (
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
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Raw file content</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="widget-drawer-validate"
              disabled={isValidating.value}
              onClick={() => void handleValidateClick()}
            >
              {isValidating.value ? 'Validating…' : 'Validate'}
            </Button>
          </div>
          <div
            data-testid="widget-drawer-raw-editor"
            className="h-80 overflow-hidden rounded-md border border-border"
          >
            <CodeEditor
              key={rawGeneration.value}
              path={`${widgetId as string}.md`}
              initialContent={rawText.value}
              dirty={rawDirty}
              onReady={(view) => {
                rawViewRef.current = view;
              }}
            />
          </div>
          {lastChecked.value && !lastChecked.value.result.ok && (
            <p data-testid="widget-drawer-raw-error" className="text-sm text-destructive">
              {lastChecked.value.result.error}
            </p>
          )}
        </div>
      )}

      {saveError.value && <p className="text-sm text-destructive">{saveError.value}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving.value || isValidating.value}>
          {isSaving.value ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
