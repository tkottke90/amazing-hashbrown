# OIDC/OAuth2 Provider Auth (Client-Credentials) — Design

**Date:** 2026-10-13
**Status:** Draft
**Issue:** [#250](https://github.com/tkottke90/amazing-hashbrown/issues/250) (milestone v.1.10.0 — Dashboards)

---

## Goal

Allow an LLM provider to be protected by OIDC/OAuth2 (OAuth2 **client-credentials grant**) instead of a static API key, so the harness works behind enterprise API gateways and with token-issuing identity providers (Azure AD, Okta, Keycloak, …).

## Problem

Today every provider client is built with a static credential read once at construction: `createProviderFromConfig()` (`api/src/services/provider-factory.ts`) passes `config.apiKey` into `ChatOpenAI`/`ChatAnthropic`, and the embedding providers in `lib/llm-wiki/src/providers/` do the same. There is no token lifecycle anywhere — nothing fetches, caches, refreshes, revokes, or rotates a credential — and no way to attach custom headers to provider requests. Issue #250 requires all of the following:

- Register an OIDC provider with client id + client secret
- Generate an access token from the OIDC configuration
- Regenerate an expired token
- Revoke credentials via the UI
- Rotate client information via the UI
- Token URL, scope, and grant type configurable
- Custom headers passed with every LLM provider client request

The MCP settings work (#188) already moved toward structured auth config and explicitly deferred "OAuth 2.0" — this design is that deferral arriving for LLM providers, kept conceptually symmetric with the MCP auth-type model.

## Non-goals

- Authorization-code / PKCE / device flows (interactive user login) — client-credentials only in phase 1.
- Embedding providers (`lib/llm-wiki/src/providers/`) — they inherit the same `AuthProvider` interface in a later phase.
- Encrypted/reference-based secret storage — phase 1 stores the client secret in the existing provider-config store, which is the same trust boundary today's `apiKey` already uses. Upgrading to a secret reference + resolver is a deferred follow-up, not a regression.
- OIDC discovery auto-fill from `/.well-known/openid-configuration` — manual token-URL entry in phase 1; discovery is UX sugar over the same config block, deferred.
- MCP server OAuth (#188's future) — that shares concepts, not code paths, in this phase.
- Refresh tokens — the client-credentials grant has no user refresh token; re-authentication uses the client credentials themselves.

## Design

### 1. Config surface

`ProviderSchema` (in `api/src/config/env.ts`) gains an optional `auth` block on each provider:

```yaml
providers:
  my-gateway:
    type: openai
    baseUrl: https://gateway.internal/v1
    auth:
      type: oidc
      tokenUrl: https://idp.internal/oauth2/token
      clientId: harness-chat
      clientSecret: <secret>        # stored as today's apiKey is; see Non-goals
      scope: "read:llm"             # optional, space-separated
      grantType: client_credentials # optional; only client_credentials accepted in phase 1
      revocationUrl: https://idp.internal/oauth2/revoke  # optional, enables RFC 7009 revocation
      headers:                      # optional, sent with every LLM request
        X-Tenant: acme
```

Validation: when `auth.type` is `oidc`, `tokenUrl` and `clientId` are required; `grantType` defaults to `client_credentials` and any other value is rejected at config load with a clear error. When `auth` is absent, behavior is exactly today's (static `apiKey`) — the feature is purely additive.

### 2. AuthProvider abstraction

New module `api/src/services/auth-providers/` :

```ts
interface AuthProvider {
  // Returns a bearer token for the Authorization header.
  getToken(): Promise<{ token: string; expiresAt: number }>;
  // Best-effort server-side revocation (RFC 7009) when the IdP exposes a
  // revocation endpoint; always clears local state. Idempotent.
  revoke(): Promise<void>;
  // Replace client credentials (rotation); clears cached tokens.
  rotate(newClient: { clientId: string; clientSecret: string }): Promise<void>;
}

class ApiKeyAuthProvider implements AuthProvider  // wraps status quo; getToken returns the static key
class OidcClientCredentialsAuthProvider implements AuthProvider
```

A small factory (`createAuthProvider(config)`) maps a `ProviderConfig` to the right implementation. `ApiKeyAuthProvider` existing first keeps the refactor behavior-neutral: the factory wiring lands before any OIDC logic, verifiable by the existing test suite.

### 3. TokenManager (inside the OIDC implementation)

Because provider clients are constructed per resolution (`createProvider()` calls `createProviderFromConfig()` fresh), the token cache **must not** live in a client instance. The OIDC implementation owns a module-level cache keyed by provider name, so a token fetched for provider X is shared across every constructed client and survives client re-creation, and a UI-triggered revoke/rotate invalidates it for all of them at once.

- **Cache & expiry:** token kept in memory with `expiresAt = issuedAt + expiresIn − SKEW_MS` (30s skew).
- **Single-flight:** concurrent `getToken()` calls share one in-flight token promise; no stampede on the token endpoint.
- **401 handling:** the fetch wrapper (below) treats a 401 from the LLM provider as cache-invalid: drop the cached token, fetch exactly once, retry the original request once. Guards against server-side revocation and clock skew; the one-retry cap prevents refresh loops against a misconfigured IdP.
- **Token request:** standard `POST tokenUrl` form-encoded (`grant_type=client_credentials`, `client_id`, `client_secret`, optional `scope`) via native `fetch`. Errors surface with the token endpoint's status/body for diagnosability.

### 4. Factory wiring

`createProviderFromConfig()` resolves an `AuthProvider` and, when it is not the static-key type (or when custom headers are configured), wraps the client's fetch:

- **ChatOpenAI:** the `configuration.fetch` hook the factory already uses for `DEBUG_LLM_HTTP` — composed (logging wraps auth wraps custom headers) rather than replaced.
- **ChatAnthropic:** `clientOptions.fetch` (the SDK forwards it to the underlying client).
- **ChatOllama:** out of scope for OIDC (local service); custom headers only, if its constructor supports them — verified during implementation, noted here rather than assumed.

The wrapper adds `Authorization: Bearer <token>` (overridable if `auth.headers` contains `Authorization`) plus the configured custom headers, then delegates to the original fetch.

### 5. Revoke / rotate semantics

- **Revoke** (`DELETE`-style action from the UI): call the IdP's revocation endpoint (RFC 7009) if `auth.revocationUrl` is configured; clear the cached token regardless; report success with a note when no revocation endpoint is configured (local-only revocation).
- **Rotate** (UI form re-submitting client id/secret): update the stored provider config through the existing settings path, then invalidate the cache and force one fresh token fetch to validate the new credentials before reporting success.
- **Regenerate** (issue AC "generate/regenerate an access token"): force-refresh — drop the cache and fetch immediately; exposed as an explicit UI action so users can recover from server-side revocation without waiting for a 401.

### 6. API + UI surface

- API: extend the existing providers settings handlers (`api/src/routes/v1/providers.route.ts` and its settings handlers) with the `auth` block on read/update, plus `regenerate`/`revoke` actions for OIDC providers. Responses never echo `clientSecret` (mask like other secrets in the codebase).
- UI: provider settings form gains an "Authentication" section — auth type (API key / OIDC), and for OIDC: token URL, client id, client secret, scope, grant type (fixed to client-credentials in phase 1, shown as such), custom headers key/value list, and Regenerate / Revoke / Rotate actions with confirm gating, following the #188 auth-dropdown pattern.

## Error handling

- **Token fetch failure:** the wrapped request fails with a clear error naming the provider and the token endpoint status — no silent fallback to the static apiKey.
- **401 after one refresh+retry:** surfaces as a normal provider error (the retry loop is capped, never infinite).
- **Malformed `auth` config:** rejected at config load with a message naming the provider and the missing/invalid field.
- **Revocation endpoint unreachable:** revoke still clears local state and returns partial success with an explanatory note.

## Testing

- **Unit (OIDC impl):** token fetch form/headers; expiry math with skew; single-flight under concurrency; 401 → single refresh → retry; 401 twice → error; rotation clears cache; revoke clears cache and calls the revocation endpoint when configured.
- **Unit (ApiKeyAuthProvider):** returns the static key; no network.
- **Unit (factory):** oidc config produces a client whose fetch sets `Authorization` and custom headers; absence of `auth` produces today's behavior byte-for-byte.
- **Existing suites:** provider-factory tests must pass unchanged after the `ApiKeyAuthProvider` refactor lands (behavior-neutral checkpoint).

## Deferred to later work

- Embedding-provider adoption of the same `AuthProvider` interface.
- OIDC discovery auto-fill.
- Reference-based secret storage (vault/env-indirection) replacing inline secrets.
- Additional grant types (`password`, `device_code`) if a real user asks.

## Open questions

None blocking — the three open questions from brainstorming were resolved during design: secrets ride the existing provider-config store (parity with `apiKey`, see Non-goals), phase 1 is chat-only, discovery is deferred.
