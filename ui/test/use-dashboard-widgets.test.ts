import { renderHook, waitFor, act } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { useDashboardWidgets } from '@/pages/dashboard/use-dashboard-widgets';
import * as api from '@/services/dashboard-api';

const mockFetch = api.fetchWidgets as jest.MockedFunction<typeof api.fetchWidgets>;

const OK_RESULT = {
  status: 'ok' as const,
  widget: {
    id: 'welcome',
    type: 'markdown' as const,
    title: 'Welcome',
    order: 0,
    content: '# hi',
  },
};

describe('useDashboardWidgets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
