import { deleteWorkspace } from '@/services/workspaces-api';

enum TestTypes {
  UNIT = '[unit]',
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('deleteWorkspace', () => {
  it(`returns the directory outcome so the page can warn about a leftover path ${TestTypes.UNIT}`, async () => {
    const body = {
      deleted: true,
      directory: { removed: false, path: '/home/me/repo', reason: 'outside-managed-roots' },
    };
    mockFetch(200, body);

    await expect(deleteWorkspace('ws-1')).resolves.toEqual(body);
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/workspaces/ws-1', { method: 'DELETE' });
  });

  it(`throws with the server's error so a failed delete is not treated as success ${TestTypes.UNIT}`, async () => {
    mockFetch(404, { error: 'Workspace ws-1 not found' });
    await expect(deleteWorkspace('ws-1')).rejects.toThrow('Workspace ws-1 not found');
  });
});
