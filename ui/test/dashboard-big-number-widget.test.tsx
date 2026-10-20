import { fireEvent, render, screen } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  deleteWidget: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { BigNumberWidget } from '@/pages/dashboard/big-number-widget';
import * as api from '@/services/dashboard-api';
import { showToast } from '@/lib/toast';
import type { BigNumberWidget as BigNumberWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

function widget(overrides: Partial<BigNumberWidgetData> = {}): BigNumberWidgetData {
  return {
    id: 'w1',
    type: 'big-number',
    title: 'Messages processed',
    subtitle: 'This month',
    order: 0,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    value: 12547,
    unit: 'messages',
    ...overrides,
  };
}

describe('BigNumberWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it("renders the widget's value and unit [unit]", () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('12,547')).toBeInTheDocument();
    expect(screen.getByText('messages')).toBeInTheDocument();
  });

  it('renders "N/A" when value is absent [unit]', () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget({ value: undefined })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('omits the unit when absent [unit]', () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget({ unit: undefined })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.queryByText('messages')).not.toBeInTheDocument();
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(global.confirm).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledWith('default', 'w1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a toast when delete fails [unit]', async () => {
    mockDelete.mockRejectedValue(new Error('server error'));
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith('error', 'server error');
  });

  it('renders an edit button that opens the widget drawer form [unit]', () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('widget-drawer-form')).toBeInTheDocument();
  });

  it('renders content in the scrollable region and buttons in the pinned action row [unit]', () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-content')).toContainElement(
      screen.getByTestId('big-number-widget'),
    );
    expect(screen.getByTestId('widget-action')).toContainElement(
      screen.getByTestId('widget-delete-button'),
    );
  });

  it('renders the copy-target button inside the action row [unit]', () => {
    render(
      <BigNumberWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-action')).toContainElement(
      screen.getByTestId('widget-copy-target-button'),
    );
  });
});
