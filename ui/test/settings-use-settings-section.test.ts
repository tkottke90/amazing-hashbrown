import { renderHook, waitFor, act } from '@testing-library/preact';

// Mock the API module BEFORE importing the hook
jest.mock('@/services/settings-api', () => {
  class SettingsValidationError extends Error {
    fieldErrors: Record<string, string[]> | string;
    constructor(fieldErrors: Record<string, string[]> | string) {
      super('Validation failed');
      this.name = 'SettingsValidationError';
      this.fieldErrors = fieldErrors;
    }
  }
  return {
    SettingsValidationError,
    fetchSettingsSection: jest.fn(),
    patchSettingsSection: jest.fn(),
  };
});

jest.mock('@/lib/toast', () => ({
  showToast: jest.fn(),
}));

import { useSettingsSection } from '@/components/settings/use-settings-section';
import * as api from '@/services/settings-api';
import { showToast } from '@/lib/toast';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;
const mockPatch = api.patchSettingsSection as jest.MockedFunction<typeof api.patchSettingsSection>;
const mockShowToast = showToast as jest.MockedFunction<typeof showToast>;

interface TestData {
  logLevel: string;
  port: number;
}

const INITIAL_DATA: TestData = { logLevel: 'info', port: 3000 };

describe('useSettingsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(INITIAL_DATA);
  });

  it('fetches data on mount and populates form', async () => {
    const { result } = renderHook(() => useSettingsSection<TestData>('general'));

    expect(result.current.form.value).toBeNull();
    await waitFor(() => expect(result.current.form.value).not.toBeNull());
    expect(result.current.form.value).toEqual(INITIAL_DATA);
    expect(mockFetch).toHaveBeenCalledWith('general');
  });

  it('isDirty is false initially after fetch', async () => {
    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.data.value).not.toBeNull());
    expect(result.current.isDirty.value).toBe(false);
  });

  it('isDirty becomes true after setField', async () => {
    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'debug'));

    expect(result.current.isDirty.value).toBe(true);
    expect(result.current.form.value?.logLevel).toBe('debug');
  });

  it('discard resets form to last saved data', async () => {
    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'debug'));
    expect(result.current.form.value?.logLevel).toBe('debug');

    act(() => result.current.discard());
    expect(result.current.form.value?.logLevel).toBe('info');
    expect(result.current.isDirty.value).toBe(false);
  });

  it('save calls patchSettingsSection and updates data on success', async () => {
    const updated: TestData = { logLevel: 'warn', port: 3000 };
    mockPatch.mockResolvedValue(updated);

    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'warn'));
    await act(async () => result.current.save());

    expect(mockPatch).toHaveBeenCalledWith('general', { logLevel: 'warn', port: 3000 });
    expect(result.current.data.value).toEqual(updated);
    expect(result.current.isDirty.value).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith('success', 'Settings saved');
  });

  it('save with 400 populates fieldErrors and shows error toast', async () => {
    const { SettingsValidationError } = await import('@/services/settings-api');
    const ve = new SettingsValidationError({ logLevel: ['Invalid value'] });
    mockPatch.mockRejectedValue(ve);

    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'bad'));
    await act(async () => result.current.save());

    expect(result.current.fieldErrors.value).toEqual({ logLevel: ['Invalid value'] });
    expect(mockShowToast).toHaveBeenCalledWith('error', 'Please fix the errors below');
  });

  it('save with 500 shows generic error toast', async () => {
    mockPatch.mockRejectedValue(new Error('Server error'));

    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'warn'));
    await act(async () => result.current.save());

    expect(mockShowToast).toHaveBeenCalledWith('error', 'Server error');
  });

  it('isSaving is true while save is in progress', async () => {
    let resolvePatch!: (v: TestData) => void;
    mockPatch.mockImplementation(
      () => new Promise<TestData>((res) => { resolvePatch = res; }),
    );

    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'warn'));

    // Start save but don't await
    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });

    await waitFor(() => expect(result.current.isSaving.value).toBe(true));

    // Resolve the patch
    await act(async () => {
      resolvePatch({ logLevel: 'warn', port: 3000 });
      await savePromise;
    });

    expect(result.current.isSaving.value).toBe(false);
  });

  it('discard clears fieldErrors', async () => {
    const { SettingsValidationError } = await import('@/services/settings-api');
    mockPatch.mockRejectedValue(new SettingsValidationError({ logLevel: ['Bad'] }));

    const { result } = renderHook(() => useSettingsSection<TestData>('general'));
    await waitFor(() => expect(result.current.form.value).not.toBeNull());

    act(() => result.current.setField('logLevel', 'bad'));
    await act(async () => result.current.save());
    expect(result.current.fieldErrors.value).toEqual({ logLevel: ['Bad'] });

    act(() => result.current.discard());
    expect(result.current.fieldErrors.value).toEqual({});
  });
});
