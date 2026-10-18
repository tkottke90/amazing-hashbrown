import { fireEvent, render, screen } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  deleteWidget: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { SpacerWidget } from '@/pages/dashboard/spacer-widget';
import * as api from '@/services/dashboard-api';
import { showToast } from '@/lib/toast';
import type { SpacerWidget as SpacerWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

function widget(overrides: Partial<SpacerWidgetData> = {}): SpacerWidgetData {
  return {
    id: 'w1',
    type: 'spacer',
    title: 'Spacer',
    order: 0,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SpacerWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders nothing outside Edit Mode — invisible, blank grid space [unit]', () => {
    const { container } = render(<SpacerWidget widget={widget()} onChanged={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a generic "Spacer" header, drag grip, and delete button in Edit Mode [unit]', () => {
    render(<SpacerWidget widget={widget()} onChanged={jest.fn()} editMode />);
    expect(screen.getByText('Spacer')).toBeInTheDocument();
    expect(screen.getByTestId('widget-drag-handle')).toBeInTheDocument();
    expect(screen.getByTestId('widget-delete-button')).toBeInTheDocument();
  });

  it('shows no provenance footer or content region — nothing but header and action [unit]', () => {
    render(<SpacerWidget widget={widget()} onChanged={jest.fn()} editMode />);
    expect(screen.queryByTestId('widget-card-provenance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('widget-content')).not.toBeInTheDocument();
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    render(<SpacerWidget widget={widget()} onChanged={onChanged} editMode />);

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(global.confirm).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledWith('default', 'w1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('delete does nothing when confirmation is declined [unit]', () => {
    global.confirm = jest.fn(() => false);
    const onChanged = jest.fn();
    render(<SpacerWidget widget={widget()} onChanged={onChanged} editMode />);

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(mockDelete).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a toast when delete fails [unit]', async () => {
    mockDelete.mockRejectedValue(new Error('server error'));
    render(<SpacerWidget widget={widget()} onChanged={jest.fn()} editMode />);

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith('error', 'server error');
  });
});
