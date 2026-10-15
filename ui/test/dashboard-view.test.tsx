import { render, screen, cleanup } from '@testing-library/preact';

import { DashboardView } from '@/pages/dashboard';
import { useDashboardWidgets } from '@/pages/dashboard/use-dashboard-widgets';
import { ThemeProvider } from '@/hooks/use-theme';

function renderDashboardView() {
  return render(
    <ThemeProvider>
      <DashboardView />
    </ThemeProvider>,
  );
}

const originalFetch = global.fetch;

beforeEach(() => {
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
  it('renders one widget card per item useDashboardWidgets returns [orchestration]', () => {
    const { container } = renderDashboardView();
    const cards = container.querySelectorAll('[data-testid="widget-card"]');
    expect(cards).toHaveLength(useDashboardWidgets().length);
  });

  it('renders the Dashboard heading [orchestration]', () => {
    renderDashboardView();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
