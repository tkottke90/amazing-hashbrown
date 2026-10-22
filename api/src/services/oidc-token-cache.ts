import type { ClientCredentials } from '../config/env.js';

// Anything that needs an OIDC Client Credentials Access Token — the Azure
// OpenAI Provider and the OpenAI-Compatible Provider (in oidc mode) both
// shape down to just this: a cache key (`name`) and the credentials
// (`auth`). See GLOSSARY.md "Provider Authentication".
export interface OidcAuthConfig {
  name: string;
  auth: ClientCredentials;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface RequestedToken {
  accessToken: string;
  expiresInSeconds: number;
}

// Re-fetch this far ahead of actual expiry rather than waiting for a request
// to be made with an already-expired token — see ADR-0025.
const REFRESH_SKEW_MS = 60_000;

// Used when an IdP's token response omits expires_in (not spec-required).
const DEFAULT_TTL_SECONDS = 3600;

export interface OidcTokenCacheDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * In-process cache of OIDC Client Credentials Access Tokens — in memory
 * only, never persisted to disk, keyed by Provider name (see ADR-0025).
 * Shared by the Azure OpenAI Provider (wired into LangChain's
 * `AzureChatOpenAI` via `azureADTokenProvider: () => cache.getToken(config)`)
 * and the OpenAI-Compatible Provider's oidc auth mode (wired into
 * `ChatOpenAI` via an authenticating `fetch` wrapper — see
 * `createOidcAuthenticatingFetch` in provider-factory.ts).
 */
export class OidcTokenCache {
  private cache = new Map<string, CachedToken>();
  // De-dupes concurrent getToken()/refresh() calls for the same provider
  // (e.g. two in-flight chat requests both finding an expired token) into
  // one outbound fetch.
  private inflight = new Map<string, Promise<string>>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: OidcTokenCacheDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  // Lazy: returns the cached Access Token unless it's expired or within the
  // refresh skew window, else fetches and caches a fresh one.
  async getToken(config: OidcAuthConfig): Promise<string> {
    const cached = this.cache.get(config.name);
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > this.now()) {
      return cached.accessToken;
    }
    return this.fetchAndCache(config);
  }

  // Always force-fetches a new token and replaces the cache entry — used by
  // the model-providers settings write path to validate a Rotate's new
  // Client Credentials before they're persisted (ADR-0026). Throws on
  // failure; a successful call also seeds the cache, so the first real chat
  // request after a Rotate doesn't need a second round trip.
  async refresh(config: OidcAuthConfig): Promise<string> {
    return this.fetchAndCache(config);
  }

  // Clears the cached token only — no IdP call, no config write (ADR-0026).
  revoke(providerName: string): void {
    this.cache.delete(providerName);
  }

  // One-off fetch-and-discard, used to verify Client Credentials from
  // inside the provider-edit modal before Save — deliberately never touches
  // `this.cache`/`this.inflight`, so it can't leave a stray entry under a
  // provisional or not-yet-saved provider name.
  async testToken(auth: ClientCredentials): Promise<{ expiresInSeconds: number }> {
    const { expiresInSeconds } = await this.requestToken(auth, 'test-oidc-token');
    return { expiresInSeconds };
  }

  private async fetchAndCache(config: OidcAuthConfig): Promise<string> {
    const existing = this.inflight.get(config.name);
    if (existing) return existing;

    const promise = this.requestToken(config.auth, config.name)
      .then((result) => {
        const cached: CachedToken = {
          accessToken: result.accessToken,
          expiresAt: this.now() + result.expiresInSeconds * 1000,
        };
        this.cache.set(config.name, cached);
        return cached.accessToken;
      })
      .finally(() => this.inflight.delete(config.name));
    this.inflight.set(config.name, promise);
    return promise;
  }

  // `context` is only used for the thrown error messages below — the cache
  // key for a real provider (`fetchAndCache`), or a fixed label for a
  // one-off `testToken` call that has no saved provider name to report.
  private async requestToken(auth: ClientCredentials, context: string): Promise<RequestedToken> {
    const body = new URLSearchParams({
      grant_type: auth.grantType,
      client_id: auth.clientId,
      client_secret: auth.clientSecret ?? '',
    });
    if (auth.scope) body.set('scope', auth.scope);

    const res = await this.fetchImpl(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OIDC token request failed for "${context}": ${res.status} ${text}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error(`OIDC token response for "${context}" had no access_token`);
    }

    return {
      accessToken: json.access_token,
      expiresInSeconds: json.expires_in ?? DEFAULT_TTL_SECONDS,
    };
  }
}

let _cache: OidcTokenCache | null = null;

export function getOidcTokenCache(): OidcTokenCache {
  if (!_cache) {
    _cache = new OidcTokenCache();
  }
  return _cache;
}
