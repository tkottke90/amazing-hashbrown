import { Router } from 'express';
import { env, type AnyProviderConfig } from '../../config/env.js';
import {
  listModels,
  listModelsOrThrow,
  listEmbeddingModels,
  resolveVisionCapabilityFromConfig,
  fetchModelDetails,
  type RawModelDetails,
} from '../../services/provider-factory.js';
import { unmaskApiKey } from './settings.handlers.js';
import { resolveAvailableFavorites } from '../../services/favorite-models.js';
import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import { getOidcTokenCache } from '../../services/oidc-token-cache.js';

// Shared by the revoke and test-oidc-token endpoints below: a Provider is
// OIDC-authenticated if it's the Azure OpenAI Provider, or an
// OpenAI-Compatible Provider in oidc mode.
function usesOidcAuth(provider: AnyProviderConfig): boolean {
  return (
    provider.type === 'azure-openai' ||
    (provider.type === 'openai-compatible' && provider.authMode === 'oidc')
  );
}

export const providersRouter = Router();

providersRouter.get('/', async (_req, res) => {
  const results = await Promise.all(
    env.providers.map(async (p) => {
      const liveIds = await listModels(p);
      // Fetched once per provider (not once per model below) so an
      // openai-type provider with N models doesn't refetch its entire
      // /models list N times just to read each one's labels.
      const rawDetailsById =
        p.type === 'openai' || p.type === 'openai-compatible'
          ? new Map((await fetchModelDetails(p)).map((d) => [d.id, d]))
          : new Map<string, RawModelDetails>();
      const pricingMap = new Map((p.models ?? []).map((m) => [m.id, m]));
      const models = await Promise.all(
        liveIds.map(async (id) => {
          const pricing = pricingMap.get(id);
          const imageInput = await resolveVisionCapabilityFromConfig(p, id, rawDetailsById.get(id));
          return {
            id,
            imageInput,
            ...(pricing
              ? { inputPricePerM: pricing.inputPricePerM, outputPricePerM: pricing.outputPricePerM }
              : {}),
          };
        }),
      );
      return {
        name: p.name,
        type: p.type,
        // The Azure OpenAI Provider has no defaultModel field — its
        // Deployment Name is its one "model" (see GLOSSARY.md "Deployment
        // Name"), reported here the same way defaultModel normally is.
        defaultModel: p.type === 'azure-openai' ? p.deploymentName : p.defaultModel,
        models,
      };
    }),
  );

  res.json({
    providers: results,
    defaultProvider: env.defaultProvider,
    favoriteModels: resolveAvailableFavorites(env.favoriteModels, results),
  });
});

interface ListModelsBody {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  // Resolves a masked ('****') apiKey against a saved provider by name
  // (the provider modal's use case) — mutually exclusive with `source`.
  name?: string;
  // Resolves a masked apiKey against the embeddings section's own stored
  // key instead — the embeddings settings panel isn't a saved provider,
  // so it has no `name` to look up in env.providers.
  source?: 'embeddings';
  // When set, filters the result to embedding-capable models instead of
  // returning every model the provider has (see listEmbeddingModels).
  capability?: 'embedding';
  // Only meaningful for type === 'openai-compatible' — selects between the
  // apiKey field above and the Client Credentials fields below for this
  // live, possibly-unsaved model-list fetch.
  authMode?: 'apiKey' | 'oidc';
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  grantType?: string;
}

// The ollama/openai/@anthropic-ai SDKs each throw a differently-shaped
// error, so this duck-types the common cases (HTTP status where present,
// Node network error codes otherwise) rather than importing all three
// SDKs' specific error classes just to distinguish "bad key" from
// "wrong URL" from "server down".
//
// The `ollama` package specifically has its own quirk worth calling out:
// its ResponseError puts the HTTP status on `.status_code`, not the
// `.status` OpenAI/Anthropic use, AND constructs the Error with an
// *object* argument instead of a string — so `.message` is always the
// unhelpful literal "[object Object]" (JS's default Error stringifies
// whatever it's given). The actual detail lives at `.error.message`.
// Confirmed by reproducing against a real OpenAI-compatible server with
// `type: 'ollama'` selected (a wrong-type/wrong-URL mismatch, exactly the
// case this function exists to explain): status_code 404, err.message
// "[object Object]", err.error.message "The requested endpoint does not
// exist".
function describeModelListError(err: unknown): string {
  if (err && typeof err === 'object') {
    const status =
      'status' in err
        ? (err as { status?: unknown }).status
        : 'status_code' in err
          ? (err as { status_code?: unknown }).status_code
          : undefined;

    const nested = 'error' in err ? (err as { error?: unknown }).error : undefined;
    const nestedMessage =
      nested &&
      typeof nested === 'object' &&
      typeof (nested as { message?: unknown }).message === 'string'
        ? (nested as { message: string }).message
        : undefined;

    if (status === 401 || status === 403) return 'Invalid API key.';
    if (status === 404) {
      return nestedMessage
        ? `Endpoint not found — check the base URL and provider type. (${nestedMessage})`
        : 'Endpoint not found — check the base URL and provider type.';
    }
    if (typeof status === 'number' && status >= 500) return 'The provider returned a server error.';

    const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
    const cause = 'cause' in err ? (err as { cause?: unknown }).cause : undefined;
    const causeCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (code === 'ECONNREFUSED' || causeCode === 'ECONNREFUSED') {
      return "Couldn't reach the server — check the base URL.";
    }
    if (code === 'ENOTFOUND' || causeCode === 'ENOTFOUND') {
      return "Couldn't resolve the server address — check the base URL.";
    }

    if (nestedMessage) return nestedMessage;
  }
  // The '[object Object]' guard is a last-resort safety net against the
  // same class of bug as the ollama package's, in case another SDK does
  // something similar in a case the checks above don't already catch.
  if (err instanceof Error && err.message && err.message !== '[object Object]') {
    return err.message;
  }
  return 'Failed to list models.';
}

// Lists models for a provider config that may not be saved yet (the
// Add/Edit provider modal calls this with whatever's currently typed in
// the form) — unlike GET /, which only ever looks up already-saved
// providers by name, and unlike listModels(), errors are reported instead
// of swallowed into an empty list, since the modal needs to tell the user
// why loading failed.
providersRouter.post('/models', async (req, res) => {
  const {
    type,
    baseUrl,
    apiKey,
    name,
    source,
    capability,
    authMode,
    tokenUrl,
    clientId,
    clientSecret,
    scope,
    grantType,
  } = req.body as ListModelsBody;

  // 4-value allow-list: 'azure-openai' is still deliberately excluded — the
  // provider modal never probes a live model list for it (no model picker
  // for that type — see the design doc §4.4/GLOSSARY.md "Deployment Name").
  if (
    type !== 'ollama' &&
    type !== 'openai' &&
    type !== 'anthropic' &&
    type !== 'openai-compatible'
  ) {
    res.status(400).json({ ok: false, error: 'Unknown provider type.' });
    return;
  }

  if (type !== 'anthropic' && !baseUrl?.trim()) {
    res.status(400).json({ ok: false, error: 'Base URL is required.' });
    return;
  }

  // apiKey/clientSecret arrive masked ('****') when the caller was seeded
  // from a saved config's GET response and the user hasn't retyped them —
  // resolve back to the real stored value, same as the settings PATCH
  // handler. `name` (a saved provider) and `source: 'embeddings'` (the
  // embeddings section's own key) are the two places a stored value can
  // come from.
  const stored: AnyProviderConfig | { apiKey?: string } | undefined = name
    ? env.providers.find((p) => p.name === name)
    : source === 'embeddings'
      ? { apiKey: env.embeddings.apiKey }
      : undefined;

  const storedApiKey =
    stored && 'type' in stored
      ? stored.type === 'openai-compatible' && stored.authMode === 'apiKey'
        ? stored.apiKey
        : stored.type === 'azure-openai' || stored.type === 'openai-compatible'
          ? undefined
          : stored.apiKey
      : stored?.apiKey;
  const resolvedApiKey = unmaskApiKey(apiKey, storedApiKey);

  const storedClientSecret =
    stored && 'type' in stored
      ? stored.type === 'azure-openai'
        ? stored.auth.clientSecret
        : stored.type === 'openai-compatible' && stored.authMode === 'oidc'
          ? stored.auth?.clientSecret
          : undefined
      : undefined;
  const resolvedClientSecret = unmaskApiKey(clientSecret, storedClientSecret);

  let provider: AnyProviderConfig;
  if (type === 'openai-compatible' && authMode === 'oidc') {
    provider = {
      name: name ?? '',
      type: 'openai-compatible',
      baseUrl: baseUrl ?? '',
      authMode: 'oidc',
      auth: {
        tokenUrl: tokenUrl ?? '',
        clientId: clientId ?? '',
        clientSecret: resolvedClientSecret,
        scope,
        grantType: grantType ?? 'client_credentials',
      },
    };
  } else if (type === 'openai-compatible') {
    provider = {
      name: name ?? '',
      type: 'openai-compatible',
      baseUrl: baseUrl ?? '',
      authMode: 'apiKey',
      apiKey: resolvedApiKey,
    };
  } else {
    provider = { name: name ?? '', type, baseUrl, apiKey: resolvedApiKey };
  }

  try {
    const models =
      capability === 'embedding'
        ? await listEmbeddingModels(provider)
        : await listModelsOrThrow(provider);
    res.json({ ok: true, data: { models } });
  } catch (err) {
    res.status(502).json({ ok: false, error: describeModelListError(err) });
  }
});

interface TestEmbeddingsBody {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// Embeds a short test string using the configured (or supplied) embedding
// provider and returns the vector dimensionality and round-trip latency.
// This exercises the full embedding code path — not just reachability — so
// a 404 "model not loaded" from Ollama surfaces here too.
providersRouter.post('/embeddings/test', async (req, res) => {
  const { type, baseUrl, apiKey, model } = req.body as TestEmbeddingsBody;

  const resolvedApiKey = unmaskApiKey(apiKey, env.embeddings.apiKey);
  const resolvedModel = (model ?? '').trim() || env.embeddings.model;
  const resolvedBaseUrl = (baseUrl ?? '').trim() || env.embeddings.baseUrl;

  if (!resolvedModel) {
    res.status(400).json({ ok: false, error: 'No model selected.' });
    return;
  }

  try {
    const embeddingProvider =
      type === 'openai'
        ? new OpenAIEmbeddingProvider({
            apiKey: resolvedApiKey,
            baseURL: resolvedBaseUrl,
            model: resolvedModel,
          })
        : new OllamaEmbeddingProvider({ baseUrl: resolvedBaseUrl, model: resolvedModel });

    const start = Date.now();
    const [vector] = await embeddingProvider.embed(['embedding test']);
    const durationMs = Date.now() - start;

    if (!vector || vector.length === 0) {
      res.status(502).json({ ok: false, error: 'Provider returned an empty embedding vector.' });
      return;
    }

    res.json({ ok: true, dims: vector.length, durationMs });
  } catch (err) {
    res.status(502).json({ ok: false, error: describeModelListError(err) });
  }
});

interface TestOidcTokenBody {
  // Resolves a masked ('****') clientSecret against this saved provider's
  // stored secret — set when editing an existing OIDC-authenticated
  // provider; omitted for a brand-new, unsaved one (nothing to resolve
  // against, so a masked/empty secret there is simply a real auth failure).
  providerName?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  grantType?: string;
}

// Verifies OIDC Client Credentials from inside the provider-edit modal,
// before Save — a one-off fetch-and-discard (OidcTokenCache.testToken never
// touches the persistent cache), so it works for a provider that doesn't
// exist yet and never leaves a stray cache entry. Shared by both
// OIDC-authenticated provider types (the Azure OpenAI Provider, and the
// OpenAI-Compatible Provider in oidc mode).
providersRouter.post('/test-oidc-token', async (req, res) => {
  const { providerName, tokenUrl, clientId, clientSecret, scope, grantType } =
    req.body as TestOidcTokenBody;

  const stored = providerName ? env.providers.find((p) => p.name === providerName) : undefined;
  const storedClientSecret =
    stored && usesOidcAuth(stored)
      ? stored.type === 'azure-openai'
        ? stored.auth.clientSecret
        : stored.type === 'openai-compatible'
          ? stored.auth?.clientSecret
          : undefined
      : undefined;
  const resolvedClientSecret = unmaskApiKey(clientSecret, storedClientSecret);

  try {
    const { expiresInSeconds } = await getOidcTokenCache().testToken({
      tokenUrl: tokenUrl ?? '',
      clientId: clientId ?? '',
      clientSecret: resolvedClientSecret,
      scope,
      grantType: grantType ?? 'client_credentials',
    });
    res.json({ ok: true, expiresInSeconds });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to verify credentials.',
    });
  }
});

// Revoke: clears the cached Access Token for an OIDC-authenticated Provider
// only (the Azure OpenAI Provider, or an OpenAI-Compatible Provider in oidc
// mode) — no config write, no IdP call (ADR-0026). Rotate (replacing
// clientId/clientSecret) goes through the normal settings PATCH flow
// instead; see settings.handlers.ts's model-providers slug.
providersRouter.post('/:name/revoke', (req, res) => {
  const { name } = req.params;
  const provider = env.providers.find((p) => p.name === name);

  if (!provider || !usesOidcAuth(provider)) {
    res.status(404).json({ ok: false, error: `OIDC-authenticated provider "${name}" not found.` });
    return;
  }

  getOidcTokenCache().revoke(name);
  res.json({ ok: true });
});
