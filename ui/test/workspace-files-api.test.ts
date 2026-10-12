import {
  fetchFileContent,
  saveFile,
  deleteFileEntry,
  SaveConflictError,
  FileFetchError,
} from '@/services/workspace-files-api';

enum TestTypes {
  UNIT = '[unit]',
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(
  status: number,
  opts: { headers?: Record<string, string>; json?: unknown; text?: string },
) {
  const headers = new Map(Object.entries(opts.headers ?? {}));
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name) ?? null },
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ''),
  }) as unknown as typeof fetch;
}

describe('fetchFileContent', () => {
  it(`reads the content and unquotes the ETag header into contentHash ${TestTypes.UNIT}`, async () => {
    mockFetch(200, { headers: { ETag: '"abc123"' }, text: 'hello world' });

    await expect(fetchFileContent('/api/v1/workspaces/ws/files/a.txt/content')).resolves.toEqual({
      content: 'hello world',
      contentHash: 'abc123',
    });
  });

  it(`throws FileFetchError with the server's error message on failure ${TestTypes.UNIT}`, async () => {
    mockFetch(404, { text: JSON.stringify({ error: 'File not found' }) });

    await expect(
      fetchFileContent('/api/v1/workspaces/ws/files/missing.txt/content'),
    ).rejects.toThrow('File not found');
  });

  it(`surfaces the response status on FileFetchError so callers can branch on 404 ${TestTypes.UNIT}`, async () => {
    mockFetch(404, { text: '{}' });

    try {
      await fetchFileContent('/api/v1/workspaces/ws/files/missing.txt/content');
      throw new Error('expected fetchFileContent to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FileFetchError);
      expect((err as FileFetchError).status).toBe(404);
    }
  });
});

describe('saveFile', () => {
  it(`sends content, baseHash, and force in the PATCH body and returns the new hash ${TestTypes.UNIT}`, async () => {
    mockFetch(200, { json: { ok: true, contentHash: 'new-hash' } });

    await expect(saveFile('/content-url', 'new text', 'old-hash')).resolves.toEqual({
      contentHash: 'new-hash',
    });
    expect(global.fetch).toHaveBeenCalledWith('/content-url', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new text', baseHash: 'old-hash', force: false }),
    });
  });

  it(`throws SaveConflictError carrying currentHash on a 409 ${TestTypes.UNIT}`, async () => {
    mockFetch(409, { json: { error: 'File was modified on disk', currentHash: 'server-hash' } });

    try {
      await saveFile('/content-url', 'new text', 'stale-hash');
      throw new Error('expected saveFile to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SaveConflictError);
      expect((err as SaveConflictError).currentHash).toBe('server-hash');
      expect((err as SaveConflictError).message).toBe('File was modified on disk');
    }
  });

  it(`passes force:true through when asked to overwrite despite a conflict ${TestTypes.UNIT}`, async () => {
    mockFetch(200, { json: { ok: true, contentHash: 'overwritten-hash' } });

    await saveFile('/content-url', 'new text', 'stale-hash', true);
    expect(global.fetch).toHaveBeenCalledWith(
      '/content-url',
      expect.objectContaining({
        body: JSON.stringify({ content: 'new text', baseHash: 'stale-hash', force: true }),
      }),
    );
  });
});

describe('deleteFileEntry', () => {
  it(`DELETEs the per-segment-encoded path and returns ok on success ${TestTypes.UNIT}`, async () => {
    mockFetch(200, { json: { deleted: true } });

    await expect(deleteFileEntry('ws-1', 'notes/a file.txt')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/files/notes/a%20file.txt', {
      method: 'DELETE',
    });
  });

  it(`returns the server's error without throwing on failure ${TestTypes.UNIT}`, async () => {
    mockFetch(404, { json: { error: '"notes/a.txt" not found' } });

    await expect(deleteFileEntry('ws-1', 'notes/a.txt')).resolves.toEqual({
      ok: false,
      error: '"notes/a.txt" not found',
    });
  });
});
