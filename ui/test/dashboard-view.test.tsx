import { render, screen, cleanup, waitFor } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  deleteWidget: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { DashboardView } from '@/pages/dashboard';
import * as api from '@/services/dashboard-api';
import { ThemeProvider } from '@/hooks/use-theme';

const mockFetch = api.fetchWidgets as jest.MockedFunction<typeof api.fetchWidgets>;

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
  mockFetch.mockResolvedValue(RESULTS);
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
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    const cards = container.querySelectorAll('[data-testid="widget-card"]');
    expect(cards).toHaveLength(RESULTS.length);
  });

  it('renders the Dashboard heading [orchestration]', () => {
    renderDashboardView();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
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
});
