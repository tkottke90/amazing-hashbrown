import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { WidgetDrawer } from '@/pages/dashboard/widget-drawer';
import * as api from '@/services/dashboard-api';
import type { MarkdownWidget } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockCreate = api.createWidget as jest.MockedFunction<typeof api.createWidget>;
const mockUpdate = api.updateWidget as jest.MockedFunction<typeof api.updateWidget>;
const mockUpdateRaw = api.updateWidgetRaw as jest.MockedFunction<typeof api.updateWidgetRaw>;

const WIDGET: MarkdownWidget = {
  id: 'w1',
  type: 'markdown',
  title: 'Original title',
  subtitle: 'Original subtitle',
  order: 0,
  content: 'Original content',
};

describe('WidgetDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('add mode renders empty title/subtitle/content fields, no type selector [unit]', () => {
    render(<WidgetDrawer mode="add" onSaved={jest.fn()} trigger={<button>Add</button>} />);
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('');
    expect(screen.queryByText(/type/i)).not.toBeInTheDocument();
  });

  it('add mode calls createWidget with the entered fields and onSaved on success [unit]', async () => {
    mockCreate.mockResolvedValue({ ...WIDGET, id: 'new' });
    const onSaved = jest.fn();
    render(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

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

  it('edit mode pre-fills fields from the given widget [unit]', () => {
    render(
      <WidgetDrawer
        mode="edit"
        widget={WIDGET}
        onSaved={jest.fn()}
        trigger={<button>Edit</button>}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('Original subtitle');
    expect(screen.getByLabelText('Content (Markdown)')).toHaveValue('Original content');
  });

  it('edit mode calls updateWidget with the widget id on save [unit]', async () => {
    mockUpdate.mockResolvedValue(WIDGET);
    const onSaved = jest.fn();
    render(
      <WidgetDrawer
        mode="edit"
        widget={WIDGET}
        onSaved={onSaved}
        trigger={<button>Edit</button>}
      />,
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

  it('raw mode renders a single textarea with the raw content, no title/subtitle fields [unit]', () => {
    render(
      <WidgetDrawer
        mode="raw"
        rawId="broken"
        rawContent={'---\nbad\n---'}
        onSaved={jest.fn()}
        trigger={<button>Fix</button>}
      />,
    );
    expect(screen.getByLabelText('Raw file content')).toHaveValue('---\nbad\n---');
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('raw mode saves via updateWidgetRaw with no validation [unit]', async () => {
    mockUpdateRaw.mockResolvedValue(undefined);
    const onSaved = jest.fn();
    render(
      <WidgetDrawer
        mode="raw"
        rawId="broken"
        rawContent={'---\nbad\n---'}
        onSaved={onSaved}
        trigger={<button>Fix</button>}
      />,
    );

    fireEvent.input(screen.getByLabelText('Raw file content'), {
      target: { value: 'still not valid yaml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateRaw).toHaveBeenCalledWith('default', 'broken', 'still not valid yaml'),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the error message and does not call onSaved when the save rejects [unit]', async () => {
    mockCreate.mockRejectedValue(new Error('title already taken'));
    const onSaved = jest.fn();
    render(<WidgetDrawer mode="add" onSaved={onSaved} trigger={<button>Add</button>} />);

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('title already taken')).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
