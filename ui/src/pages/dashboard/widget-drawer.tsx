import { useSignal, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import type { EditorView } from '@codemirror/view';
import type { JSX } from 'preact';
import type {
  DashboardWidget,
  ResolvedMetricValue,
  WidgetLoadResult,
} from '@tkottke90/amazing-hashbrown-widgets/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Markdown } from '@/components/markdown';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import {
  createWidget,
  updateWidget,
  updateWidgetRaw,
  validateWidgetRaw,
  fetchMetricCatalog,
  previewMetricValue,
  DEFAULT_DASHBOARD_ID,
  type ValidatedWidgetFields,
  type ValidateWidgetResult,
  type MetricCatalogEntry,
} from '@/services/dashboard-api';
import { serializeWidgetFile, type WidgetFrontmatterInput } from './serialize-widget-file';
import type { WidgetContentInput } from '@tkottke90/amazing-hashbrown-widgets/types';

export type WidgetDrawerMode = 'add' | 'edit';

export type WidgetDrawerProps =
  | { mode: 'add'; onSaved: () => void; trigger: JSX.Element }
  | { mode: 'edit'; target: WidgetLoadResult; onSaved: () => void; trigger: JSX.Element };

function assertNeverWidgetType(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
}

// Add/Edit for any widget type. Add gains a type picker (Select, mirroring
// mcp-server-drawer.tsx's transport picker) that chooses which field set
// renders below it; type is immutable after creation (D12), so Edit mode
// never shows the picker — its field set is fixed from the loaded widget's
// own type. Edit mode also keeps the Form/Raw tab toggle: Form is the
// structured, type-specific fields, Raw is the widget's entire file
// (frontmatter + body) edited directly via CodeMirror, gated behind manual
// validation (see the design doc's validation state machine). A widget
// whose file failed to parse opens straight onto Raw with Form unreachable.
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

  const widgetType = useSignal<DashboardWidget['type']>(initialWidget?.type ?? 'markdown');
  const title = useSignal(initialWidget?.title ?? '');
  const subtitle = useSignal(initialWidget?.subtitle ?? '');
  const order = useSignal(initialWidget?.order ?? 0);

  const content = useSignal(initialWidget?.type === 'markdown' ? initialWidget.content : '');
  const value = useSignal(
    initialWidget?.type === 'big-number' && initialWidget.value !== undefined
      ? String(initialWidget.value)
      : '',
  );
  const unit = useSignal(initialWidget?.type === 'big-number' ? (initialWidget.unit ?? '') : '');
  const color = useSignal(initialWidget?.type === 'line-graph' ? (initialWidget.color ?? '') : '');
  const colorsText = useSignal(
    initialWidget?.type === 'pie-graph' ? (initialWidget.colors?.join(',') ?? '') : '',
  );
  const csvData = useSignal(
    initialWidget?.type === 'line-graph' || initialWidget?.type === 'pie-graph'
      ? initialWidget.data
      : '',
  );
  // System Widget Metric (ADR-0011/0013) — the only thing a system widget's
  // frontmatter persists. No payload fields of its own: the value shown is
  // always the live preview below, never form input.
  const metricId = useSignal(initialWidget?.type === 'system' ? initialWidget.metric : '');
  const metricCatalog = useSignal<MetricCatalogEntry[]>([]);
  const metricPreview = useSignal<ResolvedMetricValue | undefined>(undefined);
  const metricPreviewError = useSignal<string | null>(null);
  const metricPreviewLoading = useSignal(false);

  function widgetToFrontmatterInput(
    widget: DashboardWidget | ValidatedWidgetFields,
  ): WidgetFrontmatterInput {
    const base = { title: widget.title, subtitle: widget.subtitle, order: widget.order };
    switch (widget.type) {
      case 'markdown':
        return { ...base, type: 'markdown', content: widget.content };
      case 'big-number':
        return { ...base, type: 'big-number', value: widget.value, unit: widget.unit };
      case 'line-graph':
        return { ...base, type: 'line-graph', data: widget.data, color: widget.color };
      case 'pie-graph':
        return { ...base, type: 'pie-graph', data: widget.data, colors: widget.colors };
      case 'system':
        return { ...base, type: 'system', metric: widget.metric };
      default:
        return assertNeverWidgetType(widget);
    }
  }

  function initialRawText(): string {
    if (!target) return '';
    if (target.status === 'error') return target.raw;
    return serializeWidgetFile(widgetToFrontmatterInput(target.widget));
  }

  const tab = useSignal<Tab>(loadFailed ? 'raw' : 'form');
  const rawText = useSignal(initialRawText());
  const rawGeneration = useSignal(0);
  const rawDirty = useSignal(false);
  const rawViewRef = useRef<EditorView | null>(null);

  const csvGeneration = useSignal(0);
  const csvDirty = useSignal(false);
  const csvViewRef = useRef<EditorView | null>(null);

  const lastChecked = useSignal<LastChecked | undefined>(undefined);
  const isValidating = useSignal(false);

  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  // Fires on mount and again on every reopen — resets every seeded form
  // field and all Raw/CSV/validation state, so a widget edited (or a new
  // widget half-filled-in) then abandoned doesn't leak into the next open.
  const openedAt = openCount.value;
  useEffect(() => {
    widgetType.value = initialWidget?.type ?? 'markdown';
    title.value = initialWidget?.title ?? '';
    subtitle.value = initialWidget?.subtitle ?? '';
    order.value = initialWidget?.order ?? 0;
    content.value = initialWidget?.type === 'markdown' ? initialWidget.content : '';
    value.value =
      initialWidget?.type === 'big-number' && initialWidget.value !== undefined
        ? String(initialWidget.value)
        : '';
    unit.value = initialWidget?.type === 'big-number' ? (initialWidget.unit ?? '') : '';
    color.value = initialWidget?.type === 'line-graph' ? (initialWidget.color ?? '') : '';
    colorsText.value =
      initialWidget?.type === 'pie-graph' ? (initialWidget.colors?.join(',') ?? '') : '';
    csvData.value =
      initialWidget?.type === 'line-graph' || initialWidget?.type === 'pie-graph'
        ? initialWidget.data
        : '';
    metricId.value = initialWidget?.type === 'system' ? initialWidget.metric : '';
    rawText.value = initialRawText();
    rawGeneration.value++;
    rawDirty.value = false;
    csvGeneration.value++;
    csvDirty.value = false;
    lastChecked.value = undefined;
    tab.value = loadFailed ? 'raw' : 'form';
    saveError.value = null;
  }, [openedAt]);

  // Fetched once per drawer instance (add drawer, each edit drawer) — a
  // small, mostly-static catalog; not worth a shared cache for v1.
  useEffect(() => {
    void fetchMetricCatalog()
      .then((catalog) => {
        metricCatalog.value = catalog;
      })
      .catch(() => {
        // Leave the catalog empty; the picker just has nothing to offer.
      });
  }, []);

  // Live preview (ADR-0013) — re-resolves on demand whenever the selected
  // Metric changes, purely for display; nothing here is ever saved.
  useEffect(() => {
    if (widgetType.value !== 'system' || !metricId.value) {
      metricPreview.value = undefined;
      metricPreviewError.value = null;
      return;
    }
    let cancelled = false;
    metricPreviewLoading.value = true;
    previewMetricValue(metricId.value)
      .then((resolved) => {
        if (cancelled) return;
        metricPreview.value = resolved;
        metricPreviewError.value = null;
      })
      .catch((err) => {
        if (cancelled) return;
        metricPreview.value = undefined;
        metricPreviewError.value = err instanceof Error ? err.message : 'Failed to preview metric';
      })
      .finally(() => {
        if (!cancelled) metricPreviewLoading.value = false;
      });
    return () => {
      cancelled = true;
    };
  }, [widgetType.value, metricId.value]);

  function readRawText(): string {
    return rawViewRef.current?.state.doc.toString() ?? rawText.value;
  }

  function readCsvText(): string {
    return csvViewRef.current?.state.doc.toString() ?? csvData.value;
  }

  function parsedValue(): number | undefined {
    const trimmed = value.value.trim();
    return trimmed === '' ? undefined : Number(trimmed);
  }

  function parsedColors(): string[] | undefined {
    const trimmed = colorsText.value.trim();
    if (trimmed === '') return undefined;
    return trimmed
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
  }

  function typeSpecificContentFields() {
    switch (widgetType.value) {
      case 'markdown':
        return { type: 'markdown' as const, content: content.value };
      case 'big-number':
        return {
          type: 'big-number' as const,
          value: parsedValue(),
          unit: unit.value.trim() || undefined,
        };
      case 'line-graph':
        return {
          type: 'line-graph' as const,
          data: readCsvText(),
          color: color.value.trim() || undefined,
        };
      case 'pie-graph':
        return { type: 'pie-graph' as const, data: readCsvText(), colors: parsedColors() };
      case 'system':
        return { type: 'system' as const, metric: metricId.value };
      default:
        return assertNeverWidgetType(widgetType.value);
    }
  }

  function buildWidgetContentInput(): WidgetContentInput {
    return {
      title: title.value.trim(),
      subtitle: subtitle.value.trim() || undefined,
      ...typeSpecificContentFields(),
    };
  }

  function buildFrontmatterInput(): WidgetFrontmatterInput {
    return {
      title: title.value.trim(),
      subtitle: subtitle.value.trim() || undefined,
      order: order.value,
      ...typeSpecificContentFields(),
    };
  }

  // Line/Pie's CSV body (and any color override) needs a server-side dry
  // run before it can be saved (design doc §5.1) — Markdown/Big Number
  // have nothing that needs one (free text, or a plain number input the
  // browser already constrains), so they save immediately like before.
  function needsValidationGate(): boolean {
    return (
      tab.value === 'raw' || widgetType.value === 'line-graph' || widgetType.value === 'pie-graph'
    );
  }

  function candidateRawText(): string {
    if (tab.value === 'raw') return readRawText();
    return serializeWidgetFile(buildFrontmatterInput());
  }

  async function runValidate(text: string): Promise<boolean> {
    isValidating.value = true;
    try {
      const result = await validateWidgetRaw({
        dashboardId: DEFAULT_DASHBOARD_ID,
        widgetId: widgetId ?? 'new',
        raw: text,
      });
      lastChecked.value = { text, result };
      rawDirty.value = false;
      csvDirty.value = false;
      return result.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to validate';
      lastChecked.value = { text, result: { ok: false, error: message } };
      rawDirty.value = false;
      csvDirty.value = false;
      return false;
    } finally {
      isValidating.value = false;
    }
  }

  // Only a never-checked text fires a real request; an exact cache hit
  // (same text as last time, whatever the outcome) reuses it for free;
  // anything else (edited since) stays locked pending an explicit Validate.
  async function ensureValidated(): Promise<boolean> {
    if (!needsValidationGate()) return true;
    const currentText = candidateRawText();
    const checked = lastChecked.value;
    if (checked === undefined) return runValidate(currentText);
    if (checked.text === currentText) return checked.result.ok;
    return false;
  }

  async function handleValidateClick() {
    const currentText = candidateRawText();
    if (lastChecked.value && lastChecked.value.text === currentText) return;
    await runValidate(currentText);
  }

  function enterRaw() {
    if (tab.value === 'raw') return;
    rawText.value = serializeWidgetFile(buildFrontmatterInput());
    rawGeneration.value++;
    rawDirty.value = false;
    lastChecked.value = undefined;
    tab.value = 'raw';
  }

  function applyParsedWidgetToFormFields(widget: ValidatedWidgetFields) {
    widgetType.value = widget.type;
    title.value = widget.title;
    subtitle.value = widget.subtitle ?? '';
    order.value = widget.order;
    switch (widget.type) {
      case 'markdown':
        content.value = widget.content;
        break;
      case 'big-number':
        value.value = widget.value !== undefined ? String(widget.value) : '';
        unit.value = widget.unit ?? '';
        break;
      case 'line-graph':
        csvData.value = widget.data;
        csvGeneration.value++;
        color.value = widget.color ?? '';
        break;
      case 'pie-graph':
        csvData.value = widget.data;
        csvGeneration.value++;
        colorsText.value = widget.colors?.join(',') ?? '';
        break;
      case 'system':
        // Unreachable in practice — the Raw tab is hidden entirely for
        // this type (see the Form/Raw toggle below) — kept only so this
        // switch stays exhaustive.
        metricId.value = widget.metric;
        break;
      default:
        assertNeverWidgetType(widget);
    }
  }

  async function handleFormTabClick() {
    if (tab.value === 'form') return;
    if (!(await ensureValidated())) return;
    const checked = lastChecked.value;
    if (checked?.result.ok) {
      applyParsedWidgetToFormFields(checked.result.widget);
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

    if (!(await ensureValidated())) return;

    isSaving.value = true;
    try {
      const input = buildWidgetContentInput();
      if (mode === 'add') {
        await createWidget(DEFAULT_DASHBOARD_ID, input);
      } else if (widgetId) {
        await updateWidget(DEFAULT_DASHBOARD_ID, widgetId, input);
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
      {mode === 'edit' && widgetType.value !== 'system' && (
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
          {mode === 'add' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${instanceKey}-type`}>Type</Label>
              <Select
                value={widgetType.value}
                onValueChange={(v) => (widgetType.value = v as DashboardWidget['type'])}
              >
                <SelectTrigger id={`${instanceKey}-type`} data-testid="widget-type-picker">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown" data-testid="widget-type-option-markdown">
                    Markdown
                  </SelectItem>
                  <SelectItem value="big-number" data-testid="widget-type-option-big-number">
                    Big Number
                  </SelectItem>
                  <SelectItem value="line-graph" data-testid="widget-type-option-line-graph">
                    Line Graph
                  </SelectItem>
                  <SelectItem value="pie-graph" data-testid="widget-type-option-pie-graph">
                    Pie Graph
                  </SelectItem>
                  <SelectItem value="system" data-testid="widget-type-option-system">
                    System
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

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

          {widgetType.value === 'markdown' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${instanceKey}-content`}>Content (Markdown)</Label>
              <Textarea
                id={`${instanceKey}-content`}
                rows={10}
                value={content.value}
                onInput={(e) => (content.value = (e.target as HTMLTextAreaElement).value)}
              />
            </div>
          )}

          {widgetType.value === 'big-number' && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${instanceKey}-value`}>Value</Label>
                <Input
                  id={`${instanceKey}-value`}
                  type="number"
                  value={value.value}
                  onInput={(e) => (value.value = (e.target as HTMLInputElement).value)}
                  placeholder="Leave blank for N/A"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${instanceKey}-unit`}>Unit</Label>
                <Input
                  id={`${instanceKey}-unit`}
                  value={unit.value}
                  onInput={(e) => (unit.value = (e.target as HTMLInputElement).value)}
                />
              </div>
            </>
          )}

          {widgetType.value === 'line-graph' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${instanceKey}-color`}>Color override (hex, optional)</Label>
              <Input
                id={`${instanceKey}-color`}
                data-testid="widget-drawer-color-input"
                value={color.value}
                onInput={(e) => (color.value = (e.target as HTMLInputElement).value)}
                placeholder="#3366ff"
              />
            </div>
          )}

          {widgetType.value === 'pie-graph' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${instanceKey}-colors`}>
                Color overrides (comma-separated hex, optional)
              </Label>
              <Input
                id={`${instanceKey}-colors`}
                data-testid="widget-drawer-color-input"
                value={colorsText.value}
                onInput={(e) => (colorsText.value = (e.target as HTMLInputElement).value)}
                placeholder="#3366ff,#ff6633"
              />
            </div>
          )}

          {widgetType.value === 'system' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${instanceKey}-metric`}>Metric</Label>
              <Select value={metricId.value} onValueChange={(v) => (metricId.value = v)}>
                <SelectTrigger id={`${instanceKey}-metric`} data-testid="widget-metric-picker">
                  <SelectValue placeholder="Select a metric" />
                </SelectTrigger>
                <SelectContent>
                  {metricCatalog.value.map((metric) => (
                    <SelectItem
                      key={metric.id}
                      value={metric.id}
                      data-testid={`widget-metric-option-${metric.id}`}
                    >
                      {metric.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div
                data-testid="widget-metric-preview"
                className="rounded-md border border-dashed border-border p-3"
              >
                {metricPreviewLoading.value && (
                  <span className="text-sm text-muted-foreground">Loading preview…</span>
                )}
                {!metricPreviewLoading.value && metricPreviewError.value && (
                  <span className="text-sm text-destructive">{metricPreviewError.value}</span>
                )}
                {!metricPreviewLoading.value &&
                  !metricPreviewError.value &&
                  metricPreview.value === undefined && (
                    <span className="text-sm text-muted-foreground">
                      Pick a metric to preview its current value.
                    </span>
                  )}
                {!metricPreviewLoading.value &&
                  !metricPreviewError.value &&
                  metricPreview.value?.displayType === 'big-number' && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-foreground">
                        {metricPreview.value.value === undefined
                          ? 'N/A'
                          : metricPreview.value.value.toLocaleString()}
                      </span>
                      {metricPreview.value.unit && (
                        <span className="text-sm text-muted-foreground">
                          {metricPreview.value.unit}
                        </span>
                      )}
                    </div>
                  )}
                {!metricPreviewLoading.value &&
                  !metricPreviewError.value &&
                  metricPreview.value?.displayType === 'markdown' && (
                    <Markdown>{metricPreview.value.content}</Markdown>
                  )}
              </div>
              <p className="text-xs text-muted-foreground">
                This widget is provided by the application itself and isn't editable beyond its
                title, subtitle, and which metric it shows.
              </p>
            </div>
          )}

          {(widgetType.value === 'line-graph' || widgetType.value === 'pie-graph') && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>CSV data (label,value)</Label>
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
                data-testid="widget-drawer-csv-editor"
                className="h-40 overflow-hidden rounded-md border border-border"
              >
                <CodeEditor
                  key={csvGeneration.value}
                  path={`${instanceKey}.csv`}
                  initialContent={csvData.value}
                  dirty={csvDirty}
                  onReady={(view) => {
                    csvViewRef.current = view;
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
