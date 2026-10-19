import { signal } from '@preact/signals';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/hooks/use-dashboards', () => ({
  useDashboards: jest.fn(),
}));

import { DashboardSettingsPanel } from '@/pages/dashboard/dashboard-settings-panel';
import { useDashboards } from '@/hooks/use-dashboards';
import type { DashboardListEntry } from '@/services/dashboard-api';

const mockUseDashboards = useDashboards as jest.MockedFunction<typeof useDashboards>;

const DASHBOARD: DashboardListEntry = {
  id: 'default',
  name: 'Default',
  description: 'My dashboard',
  density: 'compact',
  createdAt: '2026-01-01T00:00:00.000Z',
  path: '/dashboard/default',
};

function setupMock(opts: {
  dashboardsCount?: number;
  updateDashboard?: jest.Mock;
  deleteDashboard?: jest.Mock;
}) {
  const dashboards = signal(
    Array.from({ length: opts.dashboardsCount ?? 1 }, (_v, i) => ({ ...DASHBOARD, id: `d${i}` })),
  );
  mockUseDashboards.mockReturnValue({
    dashboards,
    activeDashboardId: signal(DASHBOARD.id),
    loading: signal(false),
    error: signal(null),
    setActiveDashboardId: jest.fn(),
    createDashboard: jest.fn(),
    updateDashboard: opts.updateDashboard ?? jest.fn().mockResolvedValue(DASHBOARD),
    deleteDashboard: opts.deleteDashboard ?? jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn(),
  } as unknown as ReturnType<typeof useDashboards>);
}

describe('DashboardSettingsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pre-fills form fields from the passed dashboard prop [unit]', () => {
    setupMock({});
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Default');
    expect(screen.getByLabelText('Description')).toHaveValue('My dashboard');
    expect(screen.getByTestId('dashboard-settings-path')).toHaveValue('/dashboard/default');
  });

  it('Save calls updateDashboard with the edited fields [unit]', async () => {
    const updateDashboard = jest.fn().mockResolvedValue(DASHBOARD);
    setupMock({ updateDashboard });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('density-toggle-roomy'));
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() =>
      expect(updateDashboard).toHaveBeenCalledWith('default', {
        name: 'Renamed',
        description: 'My dashboard',
        density: 'roomy',
      }),
    );
  });

  it('Cancel does not call updateDashboard [unit]', () => {
    const updateDashboard = jest.fn();
    setupMock({ updateDashboard });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(updateDashboard).not.toHaveBeenCalled();
  });

  it('hides the delete button when only one dashboard remains [unit]', () => {
    setupMock({ dashboardsCount: 1 });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);
    expect(screen.queryByTestId('dashboard-settings-delete')).not.toBeInTheDocument();
  });

  it('shows the delete button once a second dashboard exists [unit]', () => {
    setupMock({ dashboardsCount: 2 });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);
    expect(screen.getByTestId('dashboard-settings-delete')).toBeInTheDocument();
  });

  it('clicking delete without confirming does not call deleteDashboard [unit]', () => {
    const originalConfirm = global.confirm;
    global.confirm = jest.fn(() => false);
    const deleteDashboard = jest.fn();
    setupMock({ dashboardsCount: 2, deleteDashboard });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);

    fireEvent.click(screen.getByTestId('dashboard-settings-delete'));

    expect(deleteDashboard).not.toHaveBeenCalled();
    global.confirm = originalConfirm;
  });

  it('confirming delete calls deleteDashboard with the dashboard id [unit]', () => {
    const originalConfirm = global.confirm;
    global.confirm = jest.fn(() => true);
    const deleteDashboard = jest.fn().mockResolvedValue(undefined);
    setupMock({ dashboardsCount: 2, deleteDashboard });
    render(<DashboardSettingsPanel dashboard={DASHBOARD} trigger={<button>Settings</button>} />);

    fireEvent.click(screen.getByTestId('dashboard-settings-delete'));

    expect(deleteDashboard).toHaveBeenCalledWith('default');
    global.confirm = originalConfirm;
  });
});
