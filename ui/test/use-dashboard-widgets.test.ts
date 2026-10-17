import { renderHook, waitFor, act } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import {
  useDashboardWidgets,
  _resetDashboardWidgetsForTests,
} from '@/hooks/use-dashboard-widgets';
import * as api from '@/services/dashboard-api';

const mockFetch = api.fetchWidgets as jest.MockedFunction<typeof api.fetchWidgets>;

const OK_RESULT = {
  status: 'ok' as const,
  widget: {
    id: 'welcome',
    type: 'markdown' as const,
    title: 'Welcome',
    order: 0,
    source: 'manual' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
    content: '# hi',
  },
};

describe('useDashboardWidgets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetDashboardWidgetsForTests();
  });

  it('starts in a loading state [unit]', () => {
    mockFetch.mockResolvedValue([]);
    const { result } = renderHook(() => useDashboardWidgets());
    expect(result.current.loading.value).toBe(true);
  });

  it('fetches on mount and populates widgets [unit]', async () => {
    mockFetch.mockResolvedValue([OK_RESULT]);
    const { result } = renderHook(() => useDashboardWidgets());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.widgets.value).toEqual([OK_RESULT]);
    expect(result.current.error.value).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('default');
  });

  it('surfaces a fetch failure as an error message, not a thrown exception [unit]', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDashboardWidgets());

    await waitFor(() => expect(result.current.loading.value).toBe(false));

    expect(result.current.error.value).toBe('network down');
  });

  it('refresh() re-fetches and clears a prior error [unit]', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useDashboardWidgets());
    await waitFor(() => expect(result.current.error.value).toBe('network down'));

    mockFetch.mockResolvedValueOnce([OK_RESULT]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error.value).toBeNull();
    expect(result.current.widgets.value).toEqual([OK_RESULT]);
  });

  it('patchDashboardWidget updates a widget already loaded for its dashboard [unit]', async () => {
    mockFetch.mockResolvedValue([OK_RESULT]);
    const { result } = renderHook(() => useDashboardWidgets());
    await waitFor(() => expect(result.current.loading.value).toBe(false));

    const { patchDashboardWidget } = await import('@/hooks/use-dashboard-widgets');
    act(() => {
      patchDashboardWidget('default', {
        ...OK_RESULT.widget,
        content: '# updated',
        source: 'agent',
      });
    });

    expect(result.current.widgets.value).toEqual([
      { status: 'ok', widget: { ...OK_RESULT.widget, content: '# updated', source: 'agent' } },
    ]);
  });

  it('patchDashboardWidget is a no-op for a dashboard that has not loaded yet [unit]', async () => {
    const { patchDashboardWidget } = await import('@/hooks/use-dashboard-widgets');
    expect(() =>
      patchDashboardWidget('default', { ...OK_RESULT.widget, content: '# updated' }),
    ).not.toThrow();
  });
});
