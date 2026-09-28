import { consumeSsePost, SseHttpError } from '@/lib/sse';

// consumeSsePost's non-2xx path — a refusal from the server must surface as
// an SseHttpError carrying the server's own message, so use-thread.ts can
// tell it apart from a dropped stream (connection_lost).
describe('consumeSsePost — HTTP refusals', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function respond(status: number, statusText: string, json: () => Promise<unknown>) {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status, statusText, json }) as unknown as typeof fetch;
  }

  it('throws SseHttpError with the server error message from a JSON body [unit]', async () => {
    respond(409, 'Conflict', async () => ({ error: 'Automated run threads are read-only' }));

    const err = await consumeSsePost('/api/v1/chat/t1', {}, () => {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SseHttpError);
    expect(err).toMatchObject({ status: 409, message: 'Automated run threads are read-only' });
  });

  it('falls back to the status line when the body is not JSON [unit]', async () => {
    respond(502, 'Bad Gateway', async () => {
      throw new SyntaxError('Unexpected token <');
    });

    const err = await consumeSsePost('/api/v1/chat/t1', {}, () => {}).catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 502, message: 'HTTP 502: Bad Gateway' });
  });
});
