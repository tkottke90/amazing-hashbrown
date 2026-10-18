import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { EditorView } from '@codemirror/view';
import type { JSX } from 'preact';

jest.mock('@/services/dashboard-api', () => ({
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { WidgetDrawer } from '@/pages/dashboard/widget-drawer';
import { ThemeProvider } from '@/hooks/use-theme';
import * as api from '@/services/dashboard-api';
import type { MarkdownWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockCreate = api.createWidget as jest.MockedFunction<typeof api.createWidget>;
const mockUpdate = api.updateWidget as jest.MockedFunction<typeof api.updateWidget>;
const mockUpdateRaw = api.updateWidgetRaw as jest.MockedFunction<typeof api.updateWidgetRaw>;
const mockValidate = api.validateWidgetRaw as jest.MockedFunction<typeof api.validateWidgetRaw>;

const WIDGET: MarkdownWidget = {
  id: 'w1',
  type: 'markdown',
  title: 'Original title',
  subtitle: 'Original subtitle',
  order: 0,
  source: 'manual',
  updatedAt: '2026-01-01T00:00:00.000Z',
  content: 'Original content',
};

const OK_TARGET: Extract<WidgetLoadResult, { status: 'ok' }> = { status: 'ok', widget: WIDGET };
const ERROR_TARGET: Extract<WidgetLoadResult, { status: 'error' }> = {
  status: 'error',
  id: 'broken',
  raw: '---\nbad\n---',
  error: 'Invalid widget frontmatter: title: Required',
};

function renderDrawer(ui: JSX.Element) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

// CM6 doesn't react to plain DOM events in jsdom (no real contenteditable
// editing engine), so edits are made the same way the app itself reads
// content back out: against the live EditorView, found from its mounted
// DOM root. Mirrors `view.state.doc.toString()`'s own read side.
function typeIntoRawEditor(text: string) {
  const root = screen.getByTestId('widget-drawer-raw-editor');
  const content = root.querySelector('.cm-content');
  if (!content) throw new Error('expected a mounted CodeMirror .cm-content node');
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('expected a mounted CodeMirror view');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

describe('WidgetDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('add mode defaults to Markdown, with a type selector and empty title/subtitle/content fields [unit]', () => {
    renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);
    expect(screen.getByTestId('widget-type-picker')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('');
  });

  it('add mode calls createWidget with the entered fields (including type) and onSaved on success [unit]', async () => {
    mockCreate.mockResolvedValue({ ...WIDGET, id: 'new' });
    const onSaved = jest.fn();
    renderDrawer(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'New widget' } });
    fireEvent.input(screen.getByLabelText('Content (Markdown)'), { target: { value: 'body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('default', {
        type: 'markdown',
        title: 'New widget',
        subtitle: undefined,
        content: 'body',
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the error message and does not call onSaved when the save rejects [unit]', async () => {
    mockCreate.mockRejectedValue(new Error('title already taken'));
    const onSaved = jest.fn();
    renderDrawer(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('title already taken')).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('edit mode defaults to the Form tab, pre-filled from the given widget [unit]', () => {
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('Original subtitle');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('Original content');
    expect(screen.queryByTestId('widget-drawer-raw-editor')).not.toBeInTheDocument();
    // Type is immutable after creation (D12) — no picker in edit mode.
    expect(screen.queryByTestId('widget-type-picker')).not.toBeInTheDocument();
  });

  it('edit mode calls updateWidget with the widget id when saving from Form [unit]', async () => {
    mockUpdate.mockResolvedValue(WIDGET);
    const onSaved = jest.fn();
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={onSaved}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('default', 'w1', {
        type: 'markdown',
        title: 'Changed',
        subtitle: 'Original subtitle',
        content: 'Original content',
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('a widget whose file failed to parse opens straight onto Raw, with Form unreachable [unit]', async () => {
    mockValidate.mockResolvedValue({ ok: false, error: ERROR_TARGET.error });
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={ERROR_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Fix</button>}
      />,
    );
    expect(screen.getByTestId('widget-drawer-raw-editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('widget-drawer-tab-form'));
    await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(1));
    // Still on Raw — the silent check failed, so Form stays unreachable.
    expect(screen.getByTestId('widget-drawer-raw-editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('Save is locked on a fresh Raw entry and unlocks only after a passing validation [unit]', async () => {
    mockValidate.mockResolvedValue({ ok: false, error: 'bad frontmatter' });
    const onSaved = jest.fn();
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={onSaved}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(1));
    expect(screen.getByText('bad frontmatter')).toBeInTheDocument();
    expect(mockUpdateRaw).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('the first Save attempt on unchanged raw text silently validates then saves on success [unit]', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      widget: {
        title: 'Original title',
        subtitle: 'Original subtitle',
        type: 'markdown',
        order: 0,
        source: 'manual',
        content: 'Original content',
      },
    });
    mockUpdateRaw.mockResolvedValue(undefined);
    const onSaved = jest.fn();
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={onSaved}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateRaw).toHaveBeenCalledTimes(1));
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalled();
  });

  it('clicking Validate twice without further edits only calls the endpoint once [unit]', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      widget: {
        title: 'Original title',
        type: 'markdown',
        order: 0,
        source: 'manual',
        content: 'Original content',
      },
    });
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    fireEvent.click(screen.getByTestId('widget-drawer-validate'));
    await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('widget-drawer-validate'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it('editing the raw text re-locks Save until it is explicitly re-validated [unit]', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      widget: {
        title: 'Original title',
        type: 'markdown',
        order: 0,
        source: 'manual',
        content: 'Original content',
      },
    });
    mockUpdateRaw.mockResolvedValue(undefined);
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    fireEvent.click(screen.getByTestId('widget-drawer-validate'));
    await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(1));

    typeIntoRawEditor('edited content, not yet revalidated');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await new Promise((r) => setTimeout(r, 0));
    // Dirty since the last check — Save is a silent no-op, no new request.
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockUpdateRaw).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('widget-drawer-validate'));
    await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateRaw).toHaveBeenCalledTimes(1));
  });

  it('Form -> Raw -> Form round-trips the validated fields back into the form [unit]', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      widget: {
        title: 'Validated title',
        subtitle: 'Validated subtitle',
        type: 'markdown',
        order: 0,
        source: 'manual',
        content: 'Validated content',
      },
    });
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    fireEvent.click(screen.getByTestId('widget-drawer-tab-form'));

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Validated title'));
    expect(screen.getByLabelText('Subtitle')).toHaveValue('Validated subtitle');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('Validated content');
  });

  it('reopening the drawer resets back to the Form tab [unit]', async () => {
    mockValidate.mockResolvedValue({ ok: false, error: 'still broken' });
    renderDrawer(
      <WidgetDrawer
        mode="edit"
        target={OK_TARGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    expect(screen.getByTestId('widget-drawer-raw-editor')).toBeInTheDocument();

    // Simulate a reopen: the mock dialog fires onOpen on every trigger click.
    fireEvent.click(screen.getByText('Edit'));

    expect(screen.queryByTestId('widget-drawer-raw-editor')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
  });

  describe('type picker and per-type field sets', () => {
    it('the type picker offers all 5 types and swaps the field set on selection [unit]', async () => {
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      expect(await screen.findByRole('option', { name: 'Spacer' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('option', { name: 'Big Number' }));

      expect(screen.getByLabelText('Value')).toBeInTheDocument();
      expect(screen.getByLabelText('Unit')).toBeInTheDocument();
      expect(screen.queryByLabelText('Content (Markdown)')).not.toBeInTheDocument();
    });

    it('switching to Spacer hides Title/Subtitle and submits a bare {type: "spacer"} payload [unit]', async () => {
      mockCreate.mockResolvedValue({
        id: 'new',
        type: 'spacer',
        title: 'Spacer',
        order: 0,
        w: 1,
        h: 1,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Spacer' }));

      expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Subtitle')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('default', { type: 'spacer' }));
    });

    it('switching to Line Graph shows the color override field and the CSV editor [unit]', async () => {
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Line Graph' }));

      expect(screen.getByLabelText('Color override (hex, optional)')).toBeInTheDocument();
      expect(screen.getByTestId('widget-drawer-csv-editor')).toBeInTheDocument();
    });

    it('switching to Pie Graph shows the colors override field and the CSV editor [unit]', async () => {
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Pie Graph' }));

      expect(
        screen.getByLabelText('Color overrides (comma-separated hex, optional)'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('widget-drawer-csv-editor')).toBeInTheDocument();
    });

    it('creates a big-number widget with a blank value sent as undefined [unit]', async () => {
      mockCreate.mockResolvedValue({
        id: 'new',
        type: 'big-number',
        title: 'Count',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Big Number' }));
      fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Count' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith('default', {
          type: 'big-number',
          title: 'Count',
          subtitle: undefined,
          value: undefined,
          unit: undefined,
        }),
      );
    });

    it('creates a big-number widget with a numeric value [unit]', async () => {
      mockCreate.mockResolvedValue({
        id: 'new',
        type: 'big-number',
        title: 'Count',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Big Number' }));
      fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Count' } });
      fireEvent.input(screen.getByLabelText('Value'), { target: { value: '42' } });
      fireEvent.input(screen.getByLabelText('Unit'), { target: { value: 'things' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith('default', {
          type: 'big-number',
          title: 'Count',
          subtitle: undefined,
          value: 42,
          unit: 'things',
        }),
      );
    });

    it("a line-graph widget's Save validates the CSV before creating, and blocks on a validation failure [unit]", async () => {
      mockValidate.mockResolvedValue({ ok: false, error: 'bad csv' });
      renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Line Graph' }));
      fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Response time' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mockValidate).toHaveBeenCalledTimes(1));
      expect(screen.getByText('bad csv')).toBeInTheDocument();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('a line-graph widget creates once the CSV validates successfully [unit]', async () => {
      mockValidate.mockResolvedValue({
        ok: true,
        widget: {
          title: 'Response time',
          type: 'line-graph',
          order: 0,
          source: 'manual',
          data: 'label,value\n09:00,120',
        },
      });
      mockCreate.mockResolvedValue({
        id: 'new',
        type: 'line-graph',
        title: 'Response time',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        data: 'label,value\n09:00,120',
      });
      const onSaved = jest.fn();
      renderDrawer(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

      fireEvent.click(screen.getByTestId('widget-type-picker'));
      fireEvent.click(await screen.findByRole('option', { name: 'Line Graph' }));
      fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Response time' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      expect(onSaved).toHaveBeenCalled();
    });
  });
});
