import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { OidcTokenCache, type OidcAuthConfig } from './oidc-token-cache.js';

// This repo has no chai-as-promised — async rejection assertions use a plain
// try/catch, same idiom as workspace-files.test.ts's captureRejection.
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected promise to reject, but it resolved');
}

// A hand-rolled fake clock (the repo has no sinon) — see cron-registry.test.ts
// for the same pattern.
class FakeClock {
  private ms: number;
  constructor(iso: string) {
    this.ms = new Date(iso).getTime();
  }
  now = () => this.ms;
  advance(deltaMs: number) {
    this.ms += deltaMs;
  }
}

// Records every call and serves responses from a queue — lets a test assert
// exactly how many requests were made and exactly what each one sent.
class FakeFetch {
  calls: Array<{ url: string; init?: RequestInit }> = [];
  private queue: Array<() => Response> = [];

  queueOk(body: { access_token: string; expires_in?: number }) {
    this.queue.push(() => new Response(JSON.stringify(body), { status: 200 }));
  }

  queueError(status: number, text = 'invalid_client') {
    this.queue.push(() => new Response(text, { status }));
  }

  queueOkMissingToken() {
    this.queue.push(() => new Response(JSON.stringify({}), { status: 200 }));
  }

  fn: typeof fetch = async (url, init) => {
    this.calls.push({ url: String(url), init });
    const next = this.queue.shift();
    if (!next) throw new Error('FakeFetch: no response queued');
    return next();
  };
}

function oidcAuthConfig(overrides: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
  return {
    name: 'azure',
    auth: {
      tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'https://cognitiveservices.azure.com/.default',
      grantType: 'client_credentials',
    },
    ...overrides,
  };
}

describe('OidcTokenCache', () => {
  let clock: FakeClock;
  let fakeFetch: FakeFetch;
  let cache: OidcTokenCache;

  beforeEach(() => {
    clock = new FakeClock('2026-10-20T12:00:00.000Z');
    fakeFetch = new FakeFetch();
    cache = new OidcTokenCache({ now: clock.now, fetchImpl: fakeFetch.fn });
  });

  describe('getToken', () => {
    it('fetches and caches a token on first use [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('tok-1');
      expect(fakeFetch.calls).to.have.length(1);
    });

    it('sends a form-encoded client_credentials request body and headers [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      const { url, init } = fakeFetch.calls[0]!;
      expect(url).to.equal('https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
      expect(init?.method).to.equal('POST');
      expect((init?.headers as Record<string, string>)['Content-Type']).to.equal(
        'application/x-www-form-urlencoded',
      );
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).to.equal('client_credentials');
      expect(body.get('client_id')).to.equal('client-id');
      expect(body.get('client_secret')).to.equal('client-secret');
      expect(body.get('scope')).to.equal('https://cognitiveservices.azure.com/.default');
    });

    it('returns the cached token without a second fetch while well inside its expiry [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      clock.advance(10_000);
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('tok-1');
      expect(fakeFetch.calls).to.have.length(1);
    });

    it('re-fetches once the cached token is within the refresh skew of expiry [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      clock.advance(3600_000 - 30_000); // inside the 60s skew window
      fakeFetch.queueOk({ access_token: 'tok-2', expires_in: 3600 });
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('tok-2');
      expect(fakeFetch.calls).to.have.length(2);
    });

    it('de-dupes concurrent getToken calls for the same provider into one fetch [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      const config = oidcAuthConfig();
      const [a, b] = await Promise.all([cache.getToken(config), cache.getToken(config)]);
      expect(a).to.equal('tok-1');
      expect(b).to.equal('tok-1');
      expect(fakeFetch.calls).to.have.length(1);
    });

    it('rejects and leaves no cache entry when the token endpoint returns a non-OK response [unit]', async () => {
      fakeFetch.queueError(401);
      const err = await captureRejection(cache.getToken(oidcAuthConfig()));
      expect(err).to.be.instanceOf(Error).and.to.have.property('message').that.matches(/401/);
      // A subsequent call retries rather than returning a poisoned cache entry.
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('tok-1');
    });

    it('rejects when the token response has no access_token [unit]', async () => {
      fakeFetch.queueOkMissingToken();
      const err = await captureRejection(cache.getToken(oidcAuthConfig()));
      expect(err)
        .to.be.instanceOf(Error)
        .and.to.have.property('message')
        .that.matches(/no access_token/);
    });
  });

  describe('refresh', () => {
    it('always force-fetches even when a fresh token is already cached [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      fakeFetch.queueOk({ access_token: 'tok-2', expires_in: 3600 });
      const token = await cache.refresh(oidcAuthConfig());
      expect(token).to.equal('tok-2');
      expect(fakeFetch.calls).to.have.length(2);
      // And seeds the cache with the new token for subsequent getToken calls.
      const cached = await cache.getToken(oidcAuthConfig());
      expect(cached).to.equal('tok-2');
      expect(fakeFetch.calls).to.have.length(2);
    });

    it('throws and does not replace the cache when the new credentials fail [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      fakeFetch.queueError(401);
      const err = await captureRejection(
        cache.refresh(
          oidcAuthConfig({ auth: { ...oidcAuthConfig().auth, clientSecret: 'wrong' } }),
        ),
      );
      expect(err).to.be.instanceOf(Error).and.to.have.property('message').that.matches(/401/);
      const cached = await cache.getToken(oidcAuthConfig());
      expect(cached).to.equal('tok-1');
      expect(fakeFetch.calls).to.have.length(2);
    });
  });

  describe('revoke', () => {
    it('clears the cache entry so the next getToken re-fetches [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.getToken(oidcAuthConfig());
      cache.revoke('azure');
      fakeFetch.queueOk({ access_token: 'tok-2', expires_in: 3600 });
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('tok-2');
      expect(fakeFetch.calls).to.have.length(2);
    });

    it('is a no-op for a provider with no cached token [unit]', () => {
      expect(() => cache.revoke('never-cached')).not.to.throw();
    });
  });

  describe('testToken', () => {
    it('resolves expiresInSeconds from a successful token response [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 1800 });
      const result = await cache.testToken(oidcAuthConfig().auth);
      expect(result).to.deep.equal({ expiresInSeconds: 1800 });
    });

    it('falls back to the default TTL when expires_in is omitted [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1' });
      const result = await cache.testToken(oidcAuthConfig().auth);
      expect(result.expiresInSeconds).to.equal(3600);
    });

    it('rejects on a non-OK response, same as getToken [unit]', async () => {
      fakeFetch.queueError(401);
      const err = await captureRejection(cache.testToken(oidcAuthConfig().auth));
      expect(err).to.be.instanceOf(Error).and.to.have.property('message').that.matches(/401/);
    });

    it('rejects when the response has no access_token, same as getToken [unit]', async () => {
      fakeFetch.queueOkMissingToken();
      const err = await captureRejection(cache.testToken(oidcAuthConfig().auth));
      expect(err)
        .to.be.instanceOf(Error)
        .and.to.have.property('message')
        .that.matches(/no access_token/);
    });

    it('sends the same form-encoded client_credentials request body as getToken [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'tok-1', expires_in: 3600 });
      await cache.testToken(oidcAuthConfig().auth);
      const { init } = fakeFetch.calls[0]!;
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).to.equal('client_credentials');
      expect(body.get('client_id')).to.equal('client-id');
    });

    it('never writes to the persistent cache — a later getToken for the same name still fetches fresh [unit]', async () => {
      fakeFetch.queueOk({ access_token: 'test-only-tok', expires_in: 3600 });
      await cache.testToken(oidcAuthConfig().auth);
      expect(fakeFetch.calls).to.have.length(1);

      fakeFetch.queueOk({ access_token: 'real-tok', expires_in: 3600 });
      const token = await cache.getToken(oidcAuthConfig());
      expect(token).to.equal('real-tok');
      expect(fakeFetch.calls).to.have.length(2);
    });
  });
});
