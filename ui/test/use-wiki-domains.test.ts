import { fetchWikiDomains, wikiDomains } from '@/hooks/use-wiki-domains';

function mockDomainsResponse(body: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;

beforeEach(() => {
  wikiDomains.value = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('use-wiki-domains', () => {
  it('populates wikiDomains from the /api/v1/wiki/domains response [unit]', async () => {
    mockDomainsResponse([{ id: 'user', domain: 'user preferences', tags: [] }]);

    await fetchWikiDomains();

    expect(wikiDomains.value).toEqual([{ id: 'user', domain: 'user preferences', tags: [] }]);
  });

  it('leaves wikiDomains unchanged on a fetch failure [unit]', async () => {
    wikiDomains.value = [{ id: 'self', domain: 'agent identity', tags: [] }];
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    await fetchWikiDomains();

    expect(wikiDomains.value).toEqual([{ id: 'self', domain: 'agent identity', tags: [] }]);
  });
});
