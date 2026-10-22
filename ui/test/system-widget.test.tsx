import { render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';

jest.mock('@/services/dashboard-api', () => ({
  deleteWidget: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  // SystemWidget always mounts an edit-trigger WidgetDrawer, which previews
  // the widget's already-selected metric on mount — unlike PieGraphWidget's
  // own test, where the drawer defaults to a non-'system' type and never
  // calls this.
  previewMetricValue: jest.fn().mockResolvedValue({ displayType: 'big-number', value: 0 }),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { SystemWidget } from '@/pages/dashboard/system-widget';
import { ThemeProvider } from '@/hooks/use-theme';
import type { SystemWidget as SystemWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

function widget(overrides: Partial<SystemWidgetData> = {}): SystemWidgetData {
  return {
    id: 'w1',
    type: 'system',
    title: 'Metric widget',
    order: 0,
    w: 3,
    h: 2,
    source: 'system',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metric: 'workspace-count',
    ...overrides,
  };
}

// Same reason PieGraphWidget's own test needs this — the edit drawer's
// Metric picker mounts immediately.
function renderWidget(ui: JSX.Element) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('SystemWidget', () => {
  it('renders a dash placeholder when resolved is undefined [unit]', () => {
    renderWidget(
      <SystemWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('system-widget-value')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the big-number value and unit when resolved [unit]', () => {
    renderWidget(
      <SystemWidget
        dashboardId="default"
        density="compact"
        widget={widget({ resolved: { displayType: 'big-number', value: 42, unit: 'workspaces' } })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('system-widget-value')).toHaveTextContent('42');
    expect(screen.getByTestId('system-widget-value')).toHaveTextContent('workspaces');
  });

  it('renders markdown content when resolved [unit]', () => {
    renderWidget(
      <SystemWidget
        dashboardId="default"
        density="compact"
        widget={widget({ resolved: { displayType: 'markdown', content: 'hello world' } })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('system-widget-value')).toHaveTextContent('hello world');
  });

  it('renders the pie chart instead of a dash placeholder for a resolved pie-graph metric [unit]', () => {
    renderWidget(
      <SystemWidget
        dashboardId="default"
        density="compact"
        widget={widget({
          resolved: {
            displayType: 'pie-graph',
            labels: ['anthropic', 'openai'],
            values: [100, 50],
          },
        })}
        onChanged={jest.fn()}
      />,
    );
    const chart = screen.getByTestId('pie-graph-widget');
    expect(chart.querySelectorAll('svg path')).toHaveLength(2);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders a dash placeholder for a resolved line-graph metric (out of scope, #328) [unit]', () => {
    renderWidget(
      <SystemWidget
        dashboardId="default"
        density="compact"
        widget={widget({ resolved: { displayType: 'line-graph', labels: [], values: [] } })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-graph-widget')).not.toBeInTheDocument();
  });
});
