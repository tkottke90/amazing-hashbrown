import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/hooks/use-dashboards', () => ({
  getDashboards: jest.fn(),
}));

import { WidgetCopyTargetButton } from '@/pages/dashboard/widget-copy-target-button';
import { getDashboards } from '@/hooks/use-dashboards';

const mockGetDashboards = getDashboards as jest.MockedFunction<typeof getDashboards>;

describe('WidgetCopyTargetButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDashboards.mockReturnValue([]);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it('renders the Copy icon by default [unit]', () => {
    const { container } = render(
      <WidgetCopyTargetButton
        dashboardId="dash-1"
        widgetId="w1"
        widgetTitle="Disk space"
        widgetType="big-number"
      />,
    );
    expect(container.querySelector('svg.lucide-copy')).not.toBeNull();
    expect(container.querySelector('svg.lucide-check')).toBeNull();
  });

  it('copies a Dashboard Widget Target Snippet naming the dashboard and widget [unit]', async () => {
    mockGetDashboards.mockReturnValue([
      {
        id: 'dash-1',
        name: 'Homelab',
        density: 'compact',
        createdAt: '2026-01-01T00:00:00.000Z',
        path: '/widgets/dash-1',
      },
    ]);

    render(
      <WidgetCopyTargetButton
        dashboardId="dash-1"
        widgetId="w1"
        widgetTitle="Disk space"
        widgetType="big-number"
      />,
    );

    fireEvent.click(screen.getByTestId('widget-copy-target-button'));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Update the widget titled "Disk space" (id "w1", type "big-number") on the dashboard "Homelab" (id "dash-1").',
      ),
    );
  });

  it('falls back to the raw dashboardId as the name when no matching dashboard is found [unit]', async () => {
    mockGetDashboards.mockReturnValue([]);

    render(
      <WidgetCopyTargetButton
        dashboardId="dash-1"
        widgetId="w1"
        widgetTitle="Disk space"
        widgetType="big-number"
      />,
    );

    fireEvent.click(screen.getByTestId('widget-copy-target-button'));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Update the widget titled "Disk space" (id "w1", type "big-number") on the dashboard "dash-1" (id "dash-1").',
      ),
    );
  });

  it('swaps to the Check icon after copying, then back to Copy after the timeout [unit]', async () => {
    jest.useFakeTimers({ legacyFakeTimers: false });
    const { container } = render(
      <WidgetCopyTargetButton
        dashboardId="dash-1"
        widgetId="w1"
        widgetTitle="Disk space"
        widgetType="big-number"
      />,
    );

    fireEvent.click(screen.getByTestId('widget-copy-target-button'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    // Flush the write-text promise's resolution into the `copied` signal.
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('svg.lucide-check')).not.toBeNull();

    jest.advanceTimersByTime(1500);
    // Flush the setTimeout callback's signal update into a re-render.
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('svg.lucide-copy')).not.toBeNull();
    expect(container.querySelector('svg.lucide-check')).toBeNull();

    jest.useRealTimers();
  });
});
