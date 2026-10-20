# Azure OpenAI Provider — OIDC Client Credentials Auth — Design

Status: Ready for implementation planning
Issue: [#250](https://github.com/tkottke90/amazing-hashbrown/issues/250)
Domain model: `GLOSSARY.md` ("Provider Authentication" section — Provider, Azure OpenAI Provider, Deployment Name, Client Credentials, Access Token, Revoke, Rotate, Custom Headers), `docs/adr/0024`–`0026`

## 1. Problem

Every configured Provider today (`ollama`/`openai`/`anthropic`, see `api/src/config/env.ts#ProviderSchema`) authenticates with a flat, optional `apiKey`. #250 asks for OAuth2 Client Credentials Flow support, motivated by Azure OpenAI's auth model, plus a generic per-Provider custom-headers knob. See `GLOSSARY.md`'s "Provider Authentication" section for the canonical definitions this design introduces.

## 2. Architecture

### 2.1 Where OIDC lives

OIDC auth is scoped to one new Provider type, the Azure OpenAI Provider — it is not offered on `ollama`/`openai`/`anthropic`. Per ADR-0024, `providers[]` becomes a union of the existing `ProviderSchema` and a new, independently-shaped schema for the Azure OpenAI Provider, rather than more optional fields piled onto `ProviderSchema`. The existing schema is otherwise untouched, aside from the Custom Headers field described in §2.3.

### 2.2 Access Token lifecycle

Per ADR-0025: the Access Token is cached in memory only, keyed by Provider `name`, never persisted. A proactive-refresh cache tracks `expiresAt` (derived from the token response's `expires_in`) and re-fetches before handing out an expired/near-expiry token. It's wired into LangChain's `AzureChatOpenAI` via its `azureADTokenProvider: () => Promise<string>` constructor option — a closure calling the cache's own `getToken(providerConfig)` — so `createProviderFromConfig` (`api/src/services/provider-factory.ts`) stays synchronous; the async fetch/refresh happens lazily, inside that callback, whenever the SDK is about to make a request.

### 2.3 Revoke, Rotate, and Custom Headers

Per ADR-0026: Revoke and Rotate are not the same action, and neither maps onto a config-file write/read in the obvious way:

- **Revoke** clears the cached Access Token only. No config write, no IdP call. New endpoint (see §4.2).
- **Rotate** is not a separate UI flow — it's the normal provider-edit Save, with one added behavior: whenever `clientId`/`clientSecret` are part of the diff, the write path fetches a fresh Access Token with the new values before persisting; a failed fetch rejects the whole PATCH (400, same shape as this app's other settings validation failures) and nothing is written.

**Custom Headers** (`headers: Record<string, string>`) is an orthogonal, generic feature — it applies to every Provider type, not just the Azure OpenAI Provider. Headers are merged on top of whatever the active auth mechanism sets for that request (an Authorization header from an `apiKey` or from the Azure OpenAI Provider's Access Token); an explicit custom header wins on name collision — a plain last-write-wins merge, no special-casing by header name.

## 3. Config shape

```ts
// api/src/config/env.ts

export const ClientCredentialsSchema = z.object({
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(), // may arrive masked ('****') on PATCH — see §4.1
  scope: z.string().optional(),
  // Free text; the token request always sends it verbatim as `grant_type`.
  // No grant type other than 'client_credentials' is ever actually implemented.
  grantType: z.string().default('client_credentials'),
});

export const AzureOpenAiProviderSchema = z.object({
  name: z.string(),
  type: z.literal('azure-openai'),
  endpoint: z.string(),
  deploymentName: z.string(),
  apiVersion: z.string(),
  auth: ClientCredentialsSchema,
  headers: z.record(z.string(), z.string()).optional(),
  // Same sampling/pricing shape every other provider already has (see
  // ProviderSchema/ModelConfigSchema) — reused as-is, keyed by deploymentName
  // instead of a model id, so an Azure OpenAI Provider's pricing/sampling
  // override follows the exact same models[] pattern.
  temperature: z.number().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  maxConcurrency: z.number().int().optional(),
  models: z.array(ModelConfigSchema).optional(),
});

export type AzureOpenAiProviderConfig = z.infer<typeof AzureOpenAiProviderSchema>;

// ProviderSchema (existing): one new field, applies to ollama/openai/anthropic too.
headers: z.record(z.string(), z.string()).optional(),
```

`AppConfigSchema.providers` becomes a list of `ProviderConfig | AzureOpenAiProviderConfig`, discriminated by `type`. (Zod's `discriminatedUnion` wants a literal per member on the key field; `ProviderSchema.type` is a 3-value enum rather than a literal, so the implementation can either use a plain `z.union` with manual narrowing on `type`, or split `ProviderSchema` into three literal-tagged members to get a true discriminated union — an implementation choice, not a design one.) `parseProviders`' existing "drop only the malformed entry, never the whole list" behavior extends to Azure OpenAI Provider entries the same way.

Example `config.yaml` entry:

```yaml
providers:
  - name: my-azure-gpt4
    type: azure-openai
    endpoint: https://my-resource.openai.azure.com
    deploymentName: gpt-4o
    apiVersion: '2024-10-21'
    headers:
      x-tenant-id: acme-corp
    auth:
      tokenUrl: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
      clientId: <client-id>
      clientSecret: <client-secret>
      scope: https://cognitiveservices.azure.com/.default
      grantType: client_credentials
```

## 4. API & UI surface

### 4.1 `/api/v1/settings/model-providers` (existing slug, extended)

- **GET**: Azure OpenAI Provider entries mask `auth.clientSecret` the same way `maskApiKey` masks `apiKey` today (`****` sentinel); `clientId` and every other field are returned in plaintext, same treatment as `baseUrl`/`name`.
- **PATCH**: `unmaskApiKey`'s resolve-against-stored-value-on-`'****'` pattern extends to `auth.clientSecret`. When a submitted Azure OpenAI Provider entry's `clientId`/`clientSecret` differ from the stored values (i.e. an actual Rotate), the write path fetches a token with the new Client Credentials before calling `mergeConfigYaml` — on failure, the whole PATCH returns 400 with a field error on `providers`, nothing is written. This is a new async pre-write check; the existing `ValidateFn`/`WriteFn` extension points in `settings.handlers.ts` are synchronous today and need to accommodate it (either an async validate hook for this slug, or the check moved into an async `write`).
- Provider-name uniqueness and `favoriteModels` cross-validation (`validateFavoriteModels`) apply unchanged — an Azure OpenAI Provider is just another entry in the same list.

### 4.2 New: revoke endpoint

`POST /api/v1/providers/:name/revoke` (in `providers.route.ts`, alongside the existing `/models` and `/embeddings/test` actions) — looks up the named Azure OpenAI Provider, clears its cached Access Token, 404s if no such provider or if it isn't an Azure OpenAI Provider. No config write.

### 4.3 Provider settings UI

The existing Add/Edit Provider modal gains `azure-openai` as a `type` option, switching its fields to `endpoint`/`deploymentName`/`apiVersion`/`headers`/the Client Credentials block (`tokenUrl`/`clientId`/`clientSecret`/`scope`/`grantType`) instead of `baseUrl`/`apiKey`. A "Revoke token" button calls §4.2's endpoint directly — it's a standalone action, not part of the form's Save. No other Provider type's form changes beyond gaining an optional Custom Headers field.

### 4.4 Model listing

Per the Deployment Name entry in `GLOSSARY.md`: `GET /api/v1/providers` and `POST /api/v1/providers/models` skip the live model-list fetch entirely for an Azure OpenAI Provider — `fetchModelIds`'s `azure-openai` case returns `[config.deploymentName]` directly, no HTTP call. The provider settings UI shows that one value in place of a model picker.

## 5. Request mechanics

- **Token request**: `POST <tokenUrl>`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type`, `client_id`, `client_secret`, and `scope` (client_secret_post style — Azure AD's own expected shape). No `client_secret_basic` (HTTP Basic auth header) support — not needed for the one IdP this targets.
- **`createProviderFromConfig`** (`provider-factory.ts`) gets a new `case 'azure-openai'`, building `AzureChatOpenAI` with `azureOpenAIEndpoint`/`azureOpenAIApiDeploymentName`/`azureOpenAIApiVersion`, `azureADTokenProvider` (§2.2), sampling fields (same `resolveEffectiveSampling` already used by every other type), and `configuration: { defaultHeaders: config.headers }`.
- The existing `ollama`/`openai`/`anthropic` branches each gain their own headers passthrough per the SDK/LangChain option confirmed to exist at the pinned versions: `ChatOllama`'s own `headers` field, `ChatOpenAI`'s `configuration.defaultHeaders`, `ChatAnthropic`'s `clientOptions.defaultHeaders`.
- `fetchModelIds`/`listEmbeddingModels`/`resolveVisionCapabilityFromConfig`'s exhaustive switches each need an `azure-openai` case: model listing per §4.4; vision-capability detection falls back to the same `.profile?.imageInputs` check the existing `openai`/`anthropic` branch already uses (`AzureChatOpenAI` shares LangChain's profile mechanism).

## 6. Scope

**In scope**: Azure OpenAI Provider type (schema, factory wiring, settings GET/PATCH, revoke endpoint, UI form), Custom Headers for every Provider type, the in-memory proactive-refresh Access Token cache.

**Explicitly out of scope**:

- OIDC/`authStrategy` for `ollama`/`openai`/`anthropic` — not offered, not planned for this issue.
- An api-key auth mode for the Azure OpenAI Provider — OIDC is its only auth mode in v1.
- Any token/auth-status indicator in the UI (e.g. "token valid until X") — failures surface through the same error paths any other Provider call failure already does.
- Persisting the Access Token anywhere on disk.
- An eval-harness scenario (`suites/*.yaml`) — this is auth/connectivity plumbing, not LLM-facing behavior, so the EDD rules in `AGENTS.md` don't apply.

## 7. Terminology

See `GLOSSARY.md`'s "Provider Authentication" section for Provider, Azure OpenAI Provider, Deployment Name, Client Credentials, Access Token, Revoke, Rotate, and Custom Headers. See ADR-0024 (schema as a union, not a shared bag), ADR-0025 (in-memory Access Token, proactive refresh via lazy callback), and ADR-0026 (Revoke vs. Rotate semantics) for why.
