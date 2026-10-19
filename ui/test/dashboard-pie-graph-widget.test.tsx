import { fireEvent, render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';

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

import { PieGraphWidget } from '@/pages/dashboard/pie-graph-widget';
import { ThemeProvider } from '@/hooks/use-theme';
import * as api from '@/services/dashboard-api';
import type { PieGraphWidget as PieGraphWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

function widget(overrides: Partial<PieGraphWidgetData> = {}): PieGraphWidgetData {
  return {
    id: 'w1',
    type: 'pie-graph',
    title: 'Agent usage',
    subtitle: 'Tool distribution',
    order: 0,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    data: 'label,value\nQuery,30\nAnalysis,25\nCode,20\nSearch,25',
    ...overrides,
  };
}

// The widget's own edit-drawer Form tab mounts a CSV CodeEditor immediately
// for this type (unlike Markdown/Big Number), which needs a ThemeProvider.
function renderWidget(ui: JSX.Element) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('PieGraphWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders one svg path per CSV Body row [unit]', () => {
    renderWidget(
      <PieGraphWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    const chart = screen.getByTestId('pie-graph-widget');
    expect(chart).toBeInTheDocument();
    // Scoped to the chart wrapper, not the whole card — the edit/delete
    // buttons' lucide-preact icons are also <svg><path> elements.
    expect(chart.querySelectorAll('svg path')).toHaveLength(4);
  });

  it('falls back to the default palette per label index when no override is set [unit]', () => {
    renderWidget(
      <PieGraphWidget
        dashboardId="default"
        density="compact"
        widget={widget({ data: 'label,value\nA,1\nB,1' })}
        onChanged={jest.fn()}
      />,
    );
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    expect(paths[0]?.getAttribute('fill')).toBe('#6366f1');
    expect(paths[1]?.getAttribute('fill')).toBe('#f59e0b');
  });

  it('applies a Color Override positionally and cycles when shorter than the label count [unit]', () => {
    renderWidget(
      <PieGraphWidget
        dashboardId="default"
        density="compact"
        widget={widget({ data: 'label,value\nA,1\nB,1\nC,1', colors: ['#111111', '#222222'] })}
        onChanged={jest.fn()}
      />,
    );
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    expect(paths[0]?.getAttribute('fill')).toBe('#111111');
    expect(paths[1]?.getAttribute('fill')).toBe('#222222');
    expect(paths[2]?.getAttribute('fill')).toBe('#111111');
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    renderWidget(
      <PieGraphWidget
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

  it('renders an edit button that opens the widget drawer form [unit]', () => {
    renderWidget(
      <PieGraphWidget
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
    renderWidget(
      <PieGraphWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-content')).toContainElement(
      screen.getByTestId('pie-graph-widget'),
    );
    expect(screen.getByTestId('widget-action')).toContainElement(
      screen.getByTestId('widget-delete-button'),
    );
  });
});
