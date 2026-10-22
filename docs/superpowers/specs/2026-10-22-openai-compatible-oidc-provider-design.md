# OpenAI-Compatible Provider — Decoupling OIDC Auth from Azure's Deployment Path — Design

Status: Ready for implementation planning
Follows: `docs/superpowers/specs/2026-10-20-azure-openai-oidc-provider-design.md` (#250), ADR-0024/0025/0026
Domain model: `GLOSSARY.md` ("Provider Authentication" section, extended below)

## 1. Problem

#250 added OIDC Client Credentials auth, but scoped it to exactly one Provider
`type`: `azure-openai`, which also hard-codes Azure's native wire shape —
`AzureChatOpenAI`'s deployment-scoped URL
(`{endpoint}/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}`).
That design doc explicitly called both of the following out of scope:

- OIDC auth for any Provider type other than `azure-openai`
- An api-key auth mode for `azure-openai`

In practice, a real in-house LLM gateway can be **OIDC-authenticated but not
Azure-native on the wire** — plain OpenAI-compatible paths
(`{baseUrl}/chat/completions`) and a `model` field in the JSON body, no
deployment path segment, no `api-version` query param. Pointing such a
gateway at the `azure-openai` Provider type produces a URL it has no route
for (Azure's deployment-path shape instead of the gateway's actual OpenAI-
compatible path), surfacing as a `MODEL_NOT_FOUND`-style error from the
gateway rather than a clear configuration error from this app.

This design adds a new Provider type that keeps the OpenAI-compatible wire
shape `openai` already uses, but lets it authenticate with either a static
API key (today's only option) or OIDC Client Credentials — and adds a way to
verify OIDC credentials from inside the provider-edit modal, before Save.

## 2. Architecture

### 2.1 A new Provider type, not a change to the other two

`azure-openai` stays exactly as #250 shipped it: OIDC-only, Azure-native
deployment path. `openai` stays exactly as it is: api-key-only, plain
OpenAI-compatible path. Per ADR-0024's own precedent ("a future provider
type with its own unrelated shape follows the same pattern"), the new
combination — OpenAI-compatible wire shape + choice of auth — gets its own
type, `openai-compatible`, rather than growing `ProviderSchema` (shared by
`ollama`/`openai`/`anthropic`) with fields that would be meaningless for two
of those three.

### 2.2 Decoupling the OIDC token cache from Azure

`AzureTokenCache` (`api/src/services/azure-token-cache.ts`) already only
reads `config.name` and `config.auth.*` — nothing Azure-specific. It's
retyped to accept `{ name: string; auth: ClientCredentials }` instead of
`AzureOpenAiProviderConfig`, and renamed `OidcTokenCache` /
`getOidcTokenCache()` (pure rename — same file, same behavior, same tests
retargeted) since it's now shared by two Provider types. `azure-openai` and
`openai-compatible` (when `authMode: 'oidc'`) use the same process-wide
cache, keyed by Provider `name`, with the same proactive-refresh behavior
ADR-0025 already established.

### 2.3 The static-apiKey problem

`AzureChatOpenAI` takes a lazy `azureADTokenProvider: () => Promise<string>`
callback — the SDK calls it itself immediately before each request, so a
synchronous factory (`createProviderFromConfig`) can hand it an async
token-fetcher. Plain `ChatOpenAI`/the `openai` SDK has no equivalent:
`apiKey` is a static string fixed at construction, and `createProviderFromConfig`
is synchronous, so it can't `await` a token before constructing the client.

Fix: reuse the existing `configuration.fetch` override point (already
precedented by `loggingFetch`, `provider-factory.ts:21`) with a new
authenticating-fetch wrapper that, for `authMode: 'oidc'`, awaits
`tokenCache.getToken(config)` and overwrites the outgoing request's
`Authorization: Bearer <token>` header before calling real `fetch`. The
`ChatOpenAI` constructor still needs some non-empty `apiKey` string to pass
the underlying SDK's construction check; a harmless placeholder (e.g.
`'oidc-managed'`) is passed and immediately overwritten by the wrapper on
every request.

Model listing (`fetchModelIds`/`fetchModelDetails`) has no such mismatch —
both are already `async`, so for `authMode: 'oidc'` they simply `await
tokenCache.getToken(config)` first and construct the `OpenAI` client with
that token as `apiKey` directly.

### 2.4 Verifying OIDC credentials from the modal

A new, narrow endpoint lets the provider-edit modal verify Client
Credentials against the live IdP before the provider is ever saved — not a
reuse of Revoke (clears the persistent cache for an existing provider) or
Rotate's validate-on-PATCH (only runs as part of an actual submitted PATCH).
It's a one-off fetch-and-discard: it never touches the persistent token
cache (so it can't leave a stray cache entry keyed by an unsaved or
not-yet-renamed provider) and never returns the raw token to the browser —
only success/failure and the token's lifetime.

## 3. Config shape

```ts
// api/src/config/env.ts

export const OpenAiCompatibleProviderSchema = z
  .object({
    name: z.string(),
    type: z.literal('openai-compatible'),
    baseUrl: z.string(),
    defaultModel: z.string().optional(),
    authMode: z.enum(['apiKey', 'oidc']).default('apiKey'),
    apiKey: z.string().optional(), // required when authMode === 'apiKey'
    auth: ClientCredentialsSchema.optional(), // required when authMode === 'oidc'
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(ModelConfigSchema).optional(),
    maxConcurrency: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    seed: z.number().int().optional(),
  })
  .refine((v) => (v.authMode === 'apiKey' ? v.apiKey !== undefined : v.auth !== undefined), {
    message:
      "openai-compatible provider requires 'apiKey' when authMode is 'apiKey', or 'auth' when authMode is 'oidc'",
    path: ['authMode'],
  });

export type OpenAiCompatibleProviderConfig = z.infer<typeof OpenAiCompatibleProviderSchema>;
```

`AnyProviderSchema` (`env.ts`) becomes a 3-member union:

```ts
export const AnyProviderSchema = z.union([
  ProviderSchema,
  AzureOpenAiProviderSchema,
  OpenAiCompatibleProviderSchema,
]);
export type AnyProviderConfig =
  ProviderConfig | AzureOpenAiProviderConfig | OpenAiCompatibleProviderConfig;
```

`parseProviders` gets a `parseOpenAiCompatibleProvider` branch mirroring the
existing `parseAzureOpenAiProvider` — same "drop only the malformed entry,
never the whole list" behavior.

Example `config.yaml` entry (the motivating case — an OIDC-authenticated,
OpenAI-wire-compatible in-house gateway):

```yaml
providers:
  - name: inhouse-gateway
    type: openai-compatible
    baseUrl: https://api.uhg.com/api/cloud/api-management/ai-gateway/1.0/openai/v1
    defaultModel: gpt-5.4-mini_2026-03-17
    authMode: oidc
    auth:
      tokenUrl: https://login.example.com/oauth2/token
      clientId: <client-id>
      clientSecret: <client-secret>
      scope: https://api.uhg.com/.default
      grantType: client_credentials
```

## 4. Request mechanics

- **`createProviderFromConfig`** (`provider-factory.ts`) gets a new `case
'openai-compatible':`. For `authMode: 'apiKey'`, it's identical to the
  existing `openai` case (`ChatOpenAI` with `apiKey`, `baseURL`, sampling,
  headers). For `authMode: 'oidc'`, it constructs `ChatOpenAI` with the
  placeholder `apiKey` and `configuration.fetch` set to the new
  authenticating-fetch wrapper (§2.3), which closes over `tokenCache` and
  `config`.
- **`fetchModelIds`/`fetchModelDetails`/`listEmbeddingModels`** each get an
  `openai-compatible` case: `authMode: 'apiKey'` behaves exactly like
  `openai` today; `authMode: 'oidc'` awaits a token first, then builds the
  `OpenAI` client with it as `apiKey`.
- **`resolveVisionCapabilityFromConfig`** falls into the same
  `.profile.imageInputs` + `labels`-fallback path `openai`/`anthropic`/
  `azure-openai` already share (it goes through `createProviderFromConfig`,
  same as those). `FALLBACK_VISION_CAPABILITIES` gets a new
  `'openai-compatible': {}` entry for TS exhaustiveness.
- **Token verification endpoint**: `POST /api/v1/providers/test-oidc-token`
  (`providers.route.ts`), body `{ providerName?: string, tokenUrl, clientId,
clientSecret, scope?, grantType? }`. When `providerName` names an existing
  saved Provider and `clientSecret` is the `'****'` mask sentinel, it's
  resolved against that Provider's stored secret the same way
  `unmaskApiKey` already works for Rotate (§5). The handler calls a new
  `OidcTokenCache.testToken(auth: ClientCredentials): Promise<{ expiresInSeconds: number }>`
  method — distinct from `getToken`/`refresh`, so it never writes into the
  persistent cache under a provisional name — which runs the same token POST
  `fetchToken` already performs internally and throws on failure. The route
  handler maps that to `{ ok: true, expiresInSeconds }` or `{ ok: false,
error }`; the raw token itself never crosses the wire.

## 5. API & UI surface

### 5.1 `/api/v1/settings/model-providers` (existing slug, extended)

The three spots that already special-case `type === 'azure-openai'`
(`settings.handlers.ts`) get a parallel branch for `type === 'openai-compatible'
&& authMode === 'oidc'`:

- **GET**: masks `auth.clientSecret` the same way `azure-openai` does today;
  an `openai-compatible` entry with `authMode: 'apiKey'` masks `apiKey`
  exactly like the existing `openai`/`anthropic` branch.
- **PATCH validate**: the Rotate pre-check (fetch a fresh token with the new
  Client Credentials before writing; reject the whole PATCH on failure —
  ADR-0026) currently gates on `p.type !== 'azure-openai'`. That condition
  generalizes to "this entry doesn't use OIDC auth," covering
  `openai-compatible`/`oidc` too, via the now-shared `OidcTokenCache`.
- **PATCH write**: same `unmaskApiKey`-against-stored-value resolution,
  branched on `authMode` for this type instead of on `type` alone.

### 5.2 Revoke endpoint (existing, generalized)

`POST /api/v1/providers/:name/revoke` currently 404s for anything that
isn't `type === 'azure-openai'`. That check generalizes to "provider doesn't
use OIDC auth," so it also clears the cached token for an
`openai-compatible` entry in `oidc` mode. No other behavior changes
(ADR-0026's clear-only-no-IdP-call semantics still apply).

### 5.3 New: token verification endpoint

See §4 above (`POST /api/v1/providers/test-oidc-token`).

### 5.4 Provider settings UI

- The Add/Edit Provider modal (`provider-modal.tsx`) gains
  `openai-compatible` as a `type` option. Its form shows `baseUrl`,
  `defaultModel` (with the existing live model-list fetch, same as
  `openai`), `headers`, and an `authMode` toggle (API key / OIDC Client
  Credentials). The API-key branch reuses the existing api-key `<Input>`;
  the OIDC branch reuses the shared sub-form below.
- The Client Credentials fields (`tokenUrl`/`clientId`/`clientSecret`/
  `scope`/`grantType`), currently inlined into the Azure OpenAI form, are
  extracted into a shared component, `OidcClientCredentialsFields`. Both the
  existing Azure OpenAI form and the new `openai-compatible`/`oidc` form
  render it.
- A **"Get/refresh token"** button is added next to that shared sub-form (so
  both forms get it), calling §5.3's endpoint with the modal's current
  (possibly unsaved) field values, plus the Provider's `name` if editing an
  existing one. Shows an inline result: success → "Token acquired — expires
  in Nm"; failure → the upstream error message. Disabled until `tokenUrl`/
  `clientId` are non-empty. This is a standalone verification action, not
  part of Save — no config write, no interaction with the persistent cache.

## 6. Scope

**In scope**: the `openai-compatible` Provider type (schema, factory wiring,
model listing, vision capability), the `authMode` switch on that type only,
generalizing `AzureTokenCache` → `OidcTokenCache`, the authenticating-fetch
wrapper for the static-`apiKey` chat path, settings GET/PATCH/validate/write
and Revoke extended to the new type, the shared `OidcClientCredentialsFields`
UI component, the "Get/refresh token" button and its new endpoint (used by
both the Azure OpenAI and `openai-compatible` forms).

**Explicitly out of scope**:

- An api-key auth mode for `azure-openai` itself — it stays OIDC-only; the
  choice between api-key and OIDC lives only on `openai-compatible`.
- An Azure-native deployment-path URL scheme on `openai-compatible` — it
  always uses the OpenAI-compatible wire shape (`baseUrl` + body-level
  `model`).
- OIDC auth for `ollama`/`anthropic` — still not offered, still not
  planned.
- An eval-harness scenario (`suites/*.yaml`) — this is auth/connectivity
  plumbing, not LLM-facing behavior, same carve-out #250's design used.
- Any token-status indicator elsewhere in the UI beyond the one-off test
  button's own result (e.g. no persistent "token valid until X" display).
- `client_secret_basic` (HTTP Basic) token auth — only `client_secret_post`
  (form body), same as #250.

## 7. Terminology

Extends `GLOSSARY.md`'s "Provider Authentication" section:

**OpenAI-Compatible Provider** (new): A Provider `type` using the same
OpenAI-wire-compatible request shape as the plain `openai` Provider
(`baseUrl` + body-level `model`), but — unlike `openai` — selectable between
a static API key and OIDC/OAuth2 Client Credentials Flow auth via its
`authMode` field. Distinct from the Azure OpenAI Provider, which is
Azure-native on the wire and OIDC-only.
_Avoid_: generic provider, custom provider.

The existing **Client Credentials** / **Access Token** / **Revoke** /
**Rotate** / **Custom Headers** entries apply unchanged, now shared across
both the Azure OpenAI Provider and the OpenAI-Compatible Provider (in
`oidc` mode) rather than scoped to the former alone.

See ADR-0024 (schema as a union, not a shared bag — this design's rationale
for a new type rather than widening `ProviderSchema` or
`AzureOpenAiProviderSchema`), ADR-0025 (in-memory Access Token, proactive
refresh), and ADR-0026 (Revoke vs. Rotate semantics) — all unchanged by this
design, now serving two Provider types instead of one.
