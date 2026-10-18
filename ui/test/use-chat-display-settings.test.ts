jest.mock('@/services/settings-api', () => ({ fetchSettingsSection: jest.fn() }));

import { fetchSettingsSection } from '@/services/settings-api';
import {
  codeBlockWrap,
  fetchChatDisplaySettings,
  invalidateChatDisplaySettings,
} from '@/hooks/use-chat-display-settings';

const mockFetch = fetchSettingsSection as jest.MockedFunction<typeof fetchSettingsSection>;

beforeEach(() => {
  jest.clearAllMocks();
  // fetchChatDisplaySettings caches for 60s at module level — reset it so
  // each test starts from a cold cache regardless of order.
  invalidateChatDisplaySettings();
  codeBlockWrap.value = false;
});

describe('use-chat-display-settings', () => {
  it('populates codeBlockWrap from the agent-behavior settings response [unit]', async () => {
    mockFetch.mockResolvedValue({ chat: { codeBlockWrap: true } });

    await fetchChatDisplaySettings();

    expect(mockFetch).toHaveBeenCalledWith('agent-behavior');
    expect(codeBlockWrap.value).toBe(true);
  });

  it('falls back to false when chat.codeBlockWrap is omitted [unit]', async () => {
    codeBlockWrap.value = true;
    mockFetch.mockResolvedValue({});

    await fetchChatDisplaySettings();

    expect(codeBlockWrap.value).toBe(false);
  });

  it('serves the cached value within the TTL, so repeated navigations do not refetch [unit]', async () => {
    mockFetch.mockResolvedValue({ chat: { codeBlockWrap: true } });

    await fetchChatDisplaySettings();
    await fetchChatDisplaySettings();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidateChatDisplaySettings, so a saved toggle can take effect [unit]', async () => {
    mockFetch.mockResolvedValue({ chat: { codeBlockWrap: true } });

    await fetchChatDisplaySettings();
    invalidateChatDisplaySettings();
    await fetchChatDisplaySettings();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('leaves codeBlockWrap unchanged when the fetch fails [unit]', async () => {
    codeBlockWrap.value = true;
    mockFetch.mockRejectedValue(new Error('network error'));

    await fetchChatDisplaySettings();

    expect(codeBlockWrap.value).toBe(true);
  });
});
