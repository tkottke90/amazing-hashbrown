# Access Token held in memory only, refreshed proactively via a lazy callback

A client-credentials Access Token is cheap to reacquire (no user interaction) and short-lived, so it's cached in memory only — never persisted to disk, not even under the gitignored `config/` directory — keyed by provider name. It's refreshed proactively: the cache tracks `expiresAt` from the token response's `expires_in` and re-fetches before handing out an expired/near-expiry token, rather than reacting to a 401 from the provider (which would mean wrapping three differently-shaped SDK error types just to detect it).

Wiring it into LangChain's `AzureChatOpenAI` via its `azureADTokenProvider` callback — a closure that calls the token cache's own `getToken(providerName)` — means `createProviderFromConfig` stays synchronous; the async fetch/refresh lives entirely inside that callback, called lazily by the SDK itself whenever it's about to make a request.

## Consequences

A container restart always re-authenticates from the stored Client Credentials rather than resuming a stale session — there's no on-disk token format to secure or invalidate.
