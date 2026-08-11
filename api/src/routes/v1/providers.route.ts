import { Router } from 'express';
import { env, type ProviderConfig } from '../../config/env.js';
import {
  listModels,
  listModelsOrThrow,
  listEmbeddingModels,
} from '../../services/provider-factory.js';
import { unmaskApiKey } from './settings.handlers.js';
import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from '@tkottke90/llm-wiki/providers';

export const providersRouter = Router();

providersRouter.get('/', async (_req, res) => {
  const results = await Promise.all(
    env.providers.map(async (p) => {
      const liveIds = await listModels(p);
      const pricingMap = new Map((p.models ?? []).map((m) => [m.id, m]));
      return {
        name: p.name,
        type: p.type,
        defaultModel: p.defaultModel,
        models: liveIds.map((id) => {
          const pricing = pricingMap.get(id);
          return pricing
            ? {
                id,
                inputPricePerM: pricing.inputPricePerM,
                outputPricePerM: pricing.outputPricePerM,
              }
            : { id };
        }),
      };
    }),
  );

  res.json({ providers: results });
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
  const { type, baseUrl, apiKey, name, source, capability } = req.body as ListModelsBody;

  if (type !== 'ollama' && type !== 'openai' && type !== 'anthropic') {
    res.status(400).json({ ok: false, error: 'Unknown provider type.' });
    return;
  }

  if (type !== 'anthropic' && !baseUrl?.trim()) {
    res.status(400).json({ ok: false, error: 'Base URL is required.' });
    return;
  }

  // apiKey arrives masked ('****') when the caller was seeded from a saved
  // config's GET response and the user hasn't retyped it — resolve back
  // to the real stored key, same as the settings PATCH handler. `name`
  // (a saved provider) and `source: 'embeddings'` (the embeddings
  // section's own key) are the two places a stored key can come from.
  const stored = name
    ? env.providers.find((p) => p.name === name)
    : source === 'embeddings'
      ? { apiKey: env.embeddings.apiKey }
      : undefined;
  const resolvedApiKey = unmaskApiKey(apiKey, stored?.apiKey);

  const provider: ProviderConfig = { name: name ?? '', type, baseUrl, apiKey: resolvedApiKey };

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
