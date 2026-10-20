import type { AzureOpenAiProviderConfig } from '../config/env.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// Re-fetch this far ahead of actual expiry rather than waiting for a request
// to be made with an already-expired token — see ADR-0025.
const REFRESH_SKEW_MS = 60_000;

// Used when an IdP's token response omits expires_in (not spec-required).
const DEFAULT_TTL_SECONDS = 3600;

export interface AzureTokenCacheDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * In-process cache of Azure OpenAI Providers' OAuth2 Client Credentials
 * Access Tokens — in memory only, never persisted to disk, keyed by
 * provider name (see ADR-0025). Wired into LangChain's `AzureChatOpenAI`
 * via `azureADTokenProvider: () => cache.getToken(config)`.
 */
export class AzureTokenCache {
  private cache = new Map<string, CachedToken>();
  // De-dupes concurrent getToken()/refresh() calls for the same provider
  // (e.g. two in-flight chat requests both finding an expired token) into
  // one outbound fetch.
  private inflight = new Map<string, Promise<string>>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: AzureTokenCacheDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  // Lazy: returns the cached Access Token unless it's expired or within the
  // refresh skew window, else fetches and caches a fresh one.
  async getToken(config: AzureOpenAiProviderConfig): Promise<string> {
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
  async refresh(config: AzureOpenAiProviderConfig): Promise<string> {
    return this.fetchAndCache(config);
  }

  // Clears the cached token only — no IdP call, no config write (ADR-0026).
  revoke(providerName: string): void {
    this.cache.delete(providerName);
  }

  private async fetchAndCache(config: AzureOpenAiProviderConfig): Promise<string> {
    const existing = this.inflight.get(config.name);
    if (existing) return existing;

    const promise = this.fetchToken(config)
      .then((result) => {
        this.cache.set(config.name, result);
        return result.accessToken;
      })
      .finally(() => this.inflight.delete(config.name));
    this.inflight.set(config.name, promise);
    return promise;
  }

  private async fetchToken(config: AzureOpenAiProviderConfig): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: config.auth.grantType,
      client_id: config.auth.clientId,
      client_secret: config.auth.clientSecret ?? '',
    });
    if (config.auth.scope) body.set('scope', config.auth.scope);

    const res = await this.fetchImpl(config.auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Azure OpenAI token request failed for provider "${config.name}": ${res.status} ${text}`,
      );
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error(
        `Azure OpenAI token response for provider "${config.name}" had no access_token`,
      );
    }

    return {
      accessToken: json.access_token,
      expiresAt: this.now() + (json.expires_in ?? DEFAULT_TTL_SECONDS) * 1000,
    };
  }
}

let _cache: AzureTokenCache | null = null;

export function getAzureTokenCache(): AzureTokenCache {
  if (!_cache) {
    _cache = new AzureTokenCache();
  }
  return _cache;
}
