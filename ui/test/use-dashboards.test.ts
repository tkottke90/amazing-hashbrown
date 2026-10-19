import { renderHook, waitFor, act } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  listDashboards: jest.fn(),
  createDashboard: jest.fn(),
  updateDashboard: jest.fn(),
  deleteDashboard: jest.fn(),
}));

import { useDashboards, _resetDashboardsForTests } from '@/hooks/use-dashboards';
import * as api from '@/services/dashboard-api';

const mockListDashboards = api.listDashboards as jest.MockedFunction<typeof api.listDashboards>;
const mockCreateDashboard = api.createDashboard as jest.MockedFunction<typeof api.createDashboard>;
const mockUpdateDashboard = api.updateDashboard as jest.MockedFunction<typeof api.updateDashboard>;
const mockDeleteDashboard = api.deleteDashboard as jest.MockedFunction<typeof api.deleteDashboard>;

const DEFAULT_DASHBOARD = {
  id: 'default',
  name: 'Default',
  description: '',
  density: 'compact' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  path: '/dashboard/default',
};

const SECOND_DASHBOARD = {
  id: 'second',
  name: 'Second',
  description: '',
  density: 'compact' as const,
  createdAt: '2026-01-02T00:00:00.000Z',
  path: '/dashboard/second',
};

describe('useDashboards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetDashboardsForTests();
    localStorage.clear();
  });

  it('loads the dashboard list on mount [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD]);
    const { result } = renderHook(() => useDashboards());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.dashboards.value).toEqual([DEFAULT_DASHBOARD]);
    expect(mockListDashboards).toHaveBeenCalled();
  });

  it('falls back to the first dashboard when nothing is stored in localStorage [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    const { result } = renderHook(() => useDashboards());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.activeDashboardId.value).toBe('default');
  });

  it('restores activeDashboardId from localStorage when it matches a loaded dashboard [unit]', async () => {
    localStorage.setItem('dashboard.activeId', JSON.stringify('second'));
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    const { result } = renderHook(() => useDashboards());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.activeDashboardId.value).toBe('second');
  });

  it('falls back to the first dashboard when the stored id no longer exists [unit]', async () => {
    localStorage.setItem('dashboard.activeId', JSON.stringify('deleted-elsewhere'));
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    const { result } = renderHook(() => useDashboards());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.activeDashboardId.value).toBe('default');
  });

  it('setActiveDashboardId persists the choice to localStorage [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.loading.value).toBe(false));

    act(() => {
      result.current.setActiveDashboardId('second');
    });

    expect(result.current.activeDashboardId.value).toBe('second');
    expect(localStorage.getItem('dashboard.activeId')).toBe(JSON.stringify('second'));
  });

  it("createDashboard() posts 'Dashboard N', appends it, and sets it active [unit]", async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD]);
    const created = { ...SECOND_DASHBOARD, id: 'new-id', name: 'Dashboard 2' };
    mockCreateDashboard.mockResolvedValue(created);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.loading.value).toBe(false));

    await act(async () => {
      await result.current.createDashboard();
    });

    expect(mockCreateDashboard).toHaveBeenCalledWith('Dashboard 2');
    expect(result.current.dashboards.value).toEqual([DEFAULT_DASHBOARD, created]);
    expect(result.current.activeDashboardId.value).toBe('new-id');
  });

  it('updateDashboard() patches the matching entry in place [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD]);
    const updated = { ...DEFAULT_DASHBOARD, name: 'Renamed', density: 'roomy' as const };
    mockUpdateDashboard.mockResolvedValue(updated);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.loading.value).toBe(false));

    await act(async () => {
      await result.current.updateDashboard('default', { name: 'Renamed', density: 'roomy' });
    });

    expect(result.current.dashboards.value).toEqual([updated]);
  });

  it('deleteDashboard() on the active dashboard switches active to the first remaining [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    mockDeleteDashboard.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.loading.value).toBe(false));
    act(() => result.current.setActiveDashboardId('second'));

    await act(async () => {
      await result.current.deleteDashboard('second');
    });

    expect(result.current.dashboards.value).toEqual([DEFAULT_DASHBOARD]);
    expect(result.current.activeDashboardId.value).toBe('default');
  });

  it('deleteDashboard() on a non-active dashboard leaves active unchanged [unit]', async () => {
    mockListDashboards.mockResolvedValue([DEFAULT_DASHBOARD, SECOND_DASHBOARD]);
    mockDeleteDashboard.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.loading.value).toBe(false));
    expect(result.current.activeDashboardId.value).toBe('default');

    await act(async () => {
      await result.current.deleteDashboard('second');
    });

    expect(result.current.dashboards.value).toEqual([DEFAULT_DASHBOARD]);
    expect(result.current.activeDashboardId.value).toBe('default');
  });
});
