import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { EditorView } from '@codemirror/view';
import type { JSX } from 'preact';

jest.mock('@/services/dashboard-api', () => ({
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
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

  it('add mode renders empty title/subtitle/content fields, no type selector [unit]', () => {
    renderDrawer(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('');
    expect(screen.queryByText(/type/i)).not.toBeInTheDocument();
  });

  it('add mode calls createWidget with the entered fields and onSaved on success [unit]', async () => {
    mockCreate.mockResolvedValue({ ...WIDGET, id: 'new' });
    const onSaved = jest.fn();
    renderDrawer(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'New widget' } });
    fireEvent.input(screen.getByLabelText('Content (Markdown)'), { target: { value: 'body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('default', {
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
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={jest.fn()} trigger={<button>Edit</button>} />,
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('Original subtitle');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('Original content');
    expect(screen.queryByTestId('widget-drawer-raw-editor')).not.toBeInTheDocument();
  });

  it('edit mode calls updateWidget with the widget id when saving from Form [unit]', async () => {
    mockUpdate.mockResolvedValue(WIDGET);
    const onSaved = jest.fn();
    renderDrawer(
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={onSaved} trigger={<button>Edit</button>} />,
    );

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('default', 'w1', {
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
      <WidgetDrawer mode="edit" target={ERROR_TARGET} onSaved={jest.fn()} trigger={<button>Fix</button>} />,
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
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={onSaved} trigger={<button>Edit</button>} />,
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
      widget: { title: 'Original title', subtitle: 'Original subtitle', type: 'markdown', order: 0, content: 'Original content' },
    });
    mockUpdateRaw.mockResolvedValue(undefined);
    const onSaved = jest.fn();
    renderDrawer(
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={onSaved} trigger={<button>Edit</button>} />,
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
      widget: { title: 'Original title', type: 'markdown', order: 0, content: 'Original content' },
    });
    renderDrawer(
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={jest.fn()} trigger={<button>Edit</button>} />,
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
      widget: { title: 'Original title', type: 'markdown', order: 0, content: 'Original content' },
    });
    mockUpdateRaw.mockResolvedValue(undefined);
    renderDrawer(
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={jest.fn()} trigger={<button>Edit</button>} />,
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
        content: 'Validated content',
      },
    });
    renderDrawer(
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={jest.fn()} trigger={<button>Edit</button>} />,
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
      <WidgetDrawer mode="edit" target={OK_TARGET} onSaved={jest.fn()} trigger={<button>Edit</button>} />,
    );

    fireEvent.click(screen.getByTestId('widget-drawer-tab-raw'));
    expect(screen.getByTestId('widget-drawer-raw-editor')).toBeInTheDocument();

    // Simulate a reopen: the mock dialog fires onOpen on every trigger click.
    fireEvent.click(screen.getByText('Edit'));

    expect(screen.queryByTestId('widget-drawer-raw-editor')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
  });
});
