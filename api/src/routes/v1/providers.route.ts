import { Router } from 'express';
import { env, type ProviderConfig } from '../../config/env.js';
import { listModels, listModelsOrThrow } from '../../services/provider-factory.js';
import { unmaskApiKey } from './settings.handlers.js';

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
  name?: string;
}

// The ollama/openai/@anthropic-ai SDKs each throw a differently-shaped
// error, so this duck-types the common cases (HTTP status where present,
// Node network error codes otherwise) rather than importing all three
// SDKs' specific error classes just to distinguish "bad key" from
// "wrong URL" from "server down".
function describeModelListError(err: unknown): string {
  if (err && typeof err === 'object') {
    const status = 'status' in err ? (err as { status?: unknown }).status : undefined;
    if (status === 401 || status === 403) return 'Invalid API key.';
    if (status === 404) return 'Endpoint not found — check the base URL.';
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
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Failed to list models.';
}

// Lists models for a provider config that may not be saved yet (the
// Add/Edit provider modal calls this with whatever's currently typed in
// the form) — unlike GET /, which only ever looks up already-saved
// providers by name, and unlike listModels(), errors are reported instead
// of swallowed into an empty list, since the modal needs to tell the user
// why loading failed.
providersRouter.post('/models', async (req, res) => {
  const { type, baseUrl, apiKey, name } = req.body as ListModelsBody;

  if (type !== 'ollama' && type !== 'openai' && type !== 'anthropic') {
    res.status(400).json({ ok: false, error: 'Unknown provider type.' });
    return;
  }

  if (type !== 'anthropic' && !baseUrl?.trim()) {
    res.status(400).json({ ok: false, error: 'Base URL is required.' });
    return;
  }

  // apiKey arrives masked ('****') when the modal was seeded from a saved
  // provider's GET response and the user hasn't retyped it — resolve back
  // to the real stored key by name, same as the settings PATCH handler.
  const stored = name ? env.providers.find((p) => p.name === name) : undefined;
  const resolvedApiKey = unmaskApiKey(apiKey, stored?.apiKey);

  const provider: ProviderConfig = { name: name ?? '', type, baseUrl, apiKey: resolvedApiKey };

  try {
    const models = await listModelsOrThrow(provider);
    res.json({ ok: true, data: { models } });
  } catch (err) {
    res.status(502).json({ ok: false, error: describeModelListError(err) });
  }
});
