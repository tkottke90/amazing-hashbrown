import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  deleteWidget: jest.fn(),
  reorderWidget: jest.fn(),
  resizeWidget: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  listDashboards: jest.fn(),
  createDashboard: jest.fn(),
  updateDashboard: jest.fn(),
  deleteDashboard: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { DashboardView } from '@/pages/dashboard';
import * as api from '@/services/dashboard-api';
import { ThemeProvider } from '@/hooks/use-theme';
import { _resetDashboardsForTests } from '@/hooks/use-dashboards';

const mockFetch = api.fetchWidgets as jest.MockedFunction<typeof api.fetchWidgets>;
const mockListDashboards = api.listDashboards as jest.MockedFunction<typeof api.listDashboards>;
const mockCreateDashboard = api.createDashboard as jest.MockedFunction<typeof api.createDashboard>;

const DEFAULT_DASHBOARD = {
  id: 'default',
  name: 'Default',
  description: '',
  density: 'compact' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  path: '/dashboard/default',
};

const RESULTS = [
  {
    status: 'ok' as const,
    widget: {
      id: 'a',
      type: 'markdown' as const,
      title: 'A',
      order: 0,
      source: 'manual' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'x',
    },
  },
  {
    status: 'ok' as const,
    widget: {
      id: 'b',
      type: 'markdown' as const,
      title: 'B',
      order: 1,
      source: 'manual' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'y',
    },
  },
];

function renderDashboardView() {
  return render(
    <ThemeProvider>
      <DashboardView />
    </ThemeProvider>,
  );
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  _resetDashboardsForTests();
  mockFetch.mockResolvedValue(RESULTS);
  mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD]);
  // DashboardView renders <Layout>, which renders the default ThreadSidebar —
  // its own best-effort fetches (inbox count, thread list, etc.) just no-op
  // here, matching the pattern in threads-view.test.tsx.
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: false, json: async () => [] }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe('DashboardView [orchestration]', () => {
  it('shows a loading state before widgets arrive [orchestration]', () => {
    renderDashboardView();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders one widget card per result once loaded [orchestration]', async () => {
    const { container } = renderDashboardView();
    // Waits on the actual terminal state (cards present), not an
    // intermediate proxy like "Loading… gone" — the active dashboard's
    // widgets briefly read as an empty, already-settled [] for one tick
    // right after the dashboard list itself resolves, before its own
    // widget fetch completes.
    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid="widget-card"]')).toHaveLength(
        RESULTS.length,
      ),
    );
  });

  it('renders a tab for the migrated Default dashboard [orchestration]', async () => {
    renderDashboardView();
    await waitFor(() => expect(screen.getByTestId('dashboard-tabs')).toBeInTheDocument());
    expect(screen.getByTestId('dashboard-tab-default')).toHaveTextContent('Default');
  });

  it('renders the Add widget trigger [orchestration]', async () => {
    renderDashboardView();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByTestId('dashboard-add-widget')).toBeInTheDocument();
  });

  it('shows an error message instead of the grid when the fetch fails [orchestration]', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const { container } = renderDashboardView();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(container.querySelector('[data-testid="dashboard-grid"]')).toBeNull();
  });

  it('shows the empty-state message when the active dashboard has no widgets [orchestration]', async () => {
    mockFetch.mockResolvedValue([]);
    renderDashboardView();
    await waitFor(() => expect(screen.getByTestId('dashboard-empty-state')).toBeInTheDocument());
    expect(screen.queryByTestId('dashboard-grid')).not.toBeInTheDocument();
  });

  it('creating a dashboard switches to it, enters Edit Mode, and opens the widget-add drawer [orchestration]', async () => {
    mockFetch.mockResolvedValue([]);
    const created = {
      id: 'new-id',
      name: 'Dashboard 2',
      description: '',
      density: 'compact' as const,
      createdAt: '2026-01-02T00:00:00.000Z',
      path: '/dashboard/new-id',
    };
    mockCreateDashboard.mockResolvedValue(created);
    renderDashboardView();
    await waitFor(() => expect(screen.getByTestId('dashboard-tabs')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('dashboard-tab-create'));

    await waitFor(() => expect(screen.getByTestId('dashboard-tab-new-id')).toBeInTheDocument());
    expect(mockCreateDashboard).toHaveBeenCalledWith('Dashboard 2');
    expect(screen.getByTestId('dashboard-edit-mode-toggle')).toHaveTextContent('Done editing');
    await waitFor(() => expect(screen.getByTestId('widget-drawer-form')).toBeVisible());
  });
});
