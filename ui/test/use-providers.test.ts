import {
  fetchProviders,
  invalidateProviders,
  favoriteModels,
  providers,
} from '@/hooks/use-providers';

function mockProvidersResponse(body: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;

beforeEach(() => {
  // fetchProviders caches for 60s at module level — reset it so each test
  // starts from a cold cache regardless of order.
  invalidateProviders();
  favoriteModels.value = [];
  providers.value = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('use-providers', () => {
  it('populates favoriteModels from the /api/v1/providers response [unit]', async () => {
    mockProvidersResponse({
      providers: [{ name: 'do', type: 'openai', models: [{ id: 'llama' }] }],
      defaultProvider: 'do',
      favoriteModels: [{ provider: 'do', model: 'llama' }],
    });

    await fetchProviders();

    expect(favoriteModels.value).toEqual([{ provider: 'do', model: 'llama' }]);
  });

  it('falls back to no favorites when an older API omits the field [unit]', async () => {
    favoriteModels.value = [{ provider: 'stale', model: 'x' }];
    mockProvidersResponse({ providers: [], defaultProvider: '' });

    await fetchProviders();

    expect(favoriteModels.value).toEqual([]);
  });

  it('serves the cached result within the TTL, so repeated menu opens do not refetch [unit]', async () => {
    const fetchMock = mockProvidersResponse({ providers: [], favoriteModels: [] });

    await fetchProviders();
    await fetchProviders();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches within the TTL after invalidateProviders, so saved settings show up in chat immediately [unit]', async () => {
    const fetchMock = mockProvidersResponse({ providers: [], favoriteModels: [] });

    await fetchProviders();
    invalidateProviders();
    await fetchProviders();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
