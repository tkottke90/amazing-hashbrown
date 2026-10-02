import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { Ollama } from 'ollama';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { env, type ProviderConfig } from '../config/env.js';
import { logger } from '../config/logger.js';

// Temporary diagnostic instrumentation for investigating a suspected
// tool-call extraction bug against a local OpenAI-compatible server
// (Lemonade): logs the raw HTTP response body for every chat completion
// BEFORE the openai SDK/LangChain parses it, so a call the eval harness
// reports as toolCalled: null can be compared byte-for-byte against what
// the server actually sent. Passed as `configuration.fetch` to ChatOpenAI,
// which forwards it to the underlying `openai` client. Gated behind
// DEBUG_LLM_HTTP=1 so it's a no-op otherwise — remove once the
// investigation concludes.
async function loggingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  response
    .clone()
    .text()
    .then((body) => {
      logger.info('[debug-llm-http] raw chat completion response', {
        url: String(input),
        status: response.status,
        body,
      });
    })
    .catch((err: unknown) => {
      logger.warn('[debug-llm-http] failed to log response body', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  return response;
}

/**
 * Pure factory — accepts explicit config rather than reading env.
 * Exported so unit tests can drive it without touching the live configManager.
 */
export function createProviderFromConfig(config: ProviderConfig, model?: string): BaseChatModel {
  const resolvedModel = model ?? config.defaultModel;
  if (!resolvedModel) {
    throw new Error(`Provider "${config.name}" has no defaultModel and none was passed`);
  }

  switch (config.type) {
    case 'ollama':
      if (!config.baseUrl) {
        throw new Error(`Provider "${config.name}" (ollama) requires baseUrl`);
      }
      // timeoutMs is not wired for Ollama — ChatOllama's client has no
      // equivalent constructor option. Known gap, deliberately deferred;
      // see the design doc referenced on ProviderSchema.timeoutMs.
      return new ChatOllama({ model: resolvedModel, baseUrl: config.baseUrl });
    case 'openai':
      if (!config.apiKey) {
        logger.warn(
          `Provider "${config.name}" has no apiKey — will rely on OPENAI_API_KEY environment variable`,
        );
      }
      return new ChatOpenAI({
        model: resolvedModel,
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        configuration: {
          baseURL: config.baseUrl,
          fetch: process.env.DEBUG_LLM_HTTP === '1' ? loggingFetch : undefined,
        },
      });
    case 'anthropic':
      if (!config.apiKey) {
        logger.warn(
          `Provider "${config.name}" has no apiKey — will rely on ANTHROPIC_API_KEY environment variable`,
        );
      }
      return new ChatAnthropic({
        model: resolvedModel,
        apiKey: config.apiKey,
        // ChatAnthropic has no top-level `timeout` constructor field (unlike
        // ChatOpenAI) — it forwards `clientOptions` straight to the
        // underlying @anthropic-ai/sdk client, which is where `timeout`
        // actually lives.
        clientOptions: { timeout: config.timeoutMs },
      });
  }
}

async function fetchModelIds(provider: ProviderConfig): Promise<string[]> {
  switch (provider.type) {
    case 'ollama': {
      const client = new Ollama({ host: provider.baseUrl });
      const response = await client.list();
      return response.models.map((m) => m.name);
    }
    case 'openai': {
      const client = new OpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey });
      const response = await client.models.list();
      return response.data.map((m) => m.id);
    }
    case 'anthropic': {
      const client = new Anthropic({ apiKey: provider.apiKey });
      const response = await client.models.list();
      return response.data.map((m) => m.id);
    }
  }
}

// A model-list entry carrying whatever extra fields the server actually
// returned, beyond the id every provider type gives us. Some OpenAI-
// compatible servers (e.g. Lemonade) extend their /models response with a
// `labels` array describing model capabilities (observed in the wild:
// ["custom", "vision", "tool-calling", "mtp"]) — real OpenAI/Anthropic never
// send this, so it's always undefined for them.
export interface RawModelDetails {
  id: string;
  labels?: string[];
}

/**
 * Raw /models entries for openai-type providers — same client.models.list()
 * call fetchModelIds()'s openai branch already makes, but keeping the full
 * entry instead of mapping straight to `.id` so extra fields like `labels`
 * (duck-typed, since the openai SDK's response type won't declare them) are
 * available to callers like resolveVisionCapabilityFromConfig(). Best-
 * effort, matching listModels()'s convention: any failure (network error,
 * bad key, provider down) degrades to an empty array rather than throwing.
 * Returns [] immediately for any non-openai provider type, since only
 * openai-type /models responses are known to carry this extra data.
 */
export async function fetchModelDetails(provider: ProviderConfig): Promise<RawModelDetails[]> {
  if (provider.type !== 'openai') return [];
  try {
    const client = new OpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey });
    const response = await client.models.list();
    return response.data as RawModelDetails[];
  } catch {
    return [];
  }
}

/**
 * Best-effort — swallows any failure (network error, bad key, provider
 * down) into an empty list. Used where the caller has no way to surface a
 * specific error to the user (e.g. the chat model picker's background
 * refresh via GET /api/v1/providers).
 */
export async function listModels(provider: ProviderConfig): Promise<string[]> {
  try {
    return await fetchModelIds(provider);
  } catch {
    return [];
  }
}

/**
 * Same underlying fetch as listModels, but lets the caller see and report
 * the real failure — used by POST /api/v1/providers/models, where the
 * caller (the provider modal) needs to show the user why listing failed.
 */
export async function listModelsOrThrow(provider: ProviderConfig): Promise<string[]> {
  return fetchModelIds(provider);
}

/**
 * Same as listModelsOrThrow, filtered down to models actually capable of
 * generating embeddings — used by the Embeddings settings panel, which
 * shouldn't offer chat/completion models as a default embedding model.
 *
 * Ollama's /api/show response includes an authoritative `capabilities`
 * array (confirmed against a real instance: 'embedding' for
 * nomic-embed-text, ['completion', 'tools', 'thinking'] for a chat model
 * like qwen3) — one show() call per listed model, run in parallel. A
 * single model's show() failing excludes just that model rather than
 * failing the whole list.
 *
 * OpenAI-compatible servers (including custom ones like Lemonade) have no
 * equivalent capability-discovery endpoint — /v1/models returns only id/
 * object/created/owned_by — so this falls back to a name heuristic
 * ("embed" appears in the id), which covers real OpenAI's embedding
 * models and every embedding model observed from Lemonade's catalog.
 */
export async function listEmbeddingModels(provider: ProviderConfig): Promise<string[]> {
  const allModels = await fetchModelIds(provider);

  if (provider.type === 'ollama') {
    const client = new Ollama({ host: provider.baseUrl });
    const isEmbedding = await Promise.all(
      allModels.map(async (name) => {
        try {
          const info = await client.show({ model: name });
          return info.capabilities?.includes('embedding') ?? false;
        } catch {
          return false;
        }
      }),
    );
    return allModels.filter((_, i) => isEmbedding[i]);
  }

  if (provider.type === 'openai') {
    return allModels.filter((id) => id.toLowerCase().includes('embed'));
  }

  return allModels;
}

export function resolveProviderConfig(name?: string): ProviderConfig {
  const providers = env.providers;
  if (providers.length === 0) {
    throw new Error('No providers configured. Add a providers[] block to config.yaml.');
  }

  // providers.length === 0 already threw above, so providers[0] is guaranteed to exist.
  const targetName = name ?? env.defaultProvider ?? providers[0]!.name;
  const providerConfig = providers.find((p) => p.name === targetName);

  if (!providerConfig) {
    throw new Error(`Provider "${targetName}" not found in config.yaml providers list.`);
  }

  return providerConfig;
}

export function createProvider(name?: string, model?: string): BaseChatModel {
  return createProviderFromConfig(resolveProviderConfig(name), model);
}

/**
 * Checks Ollama's own /api/show `capabilities` array for `'vision'` on a
 * single model — the live, authoritative source for Ollama, since
 * ChatOllama never overrides LangChain's `.profile` (it always inherits
 * the base stub, which returns `{}`). Mirrors listEmbeddingModels()'s
 * existing per-model `client.show()` pattern for `'embedding'` detection.
 * Client is injected so this is unit-testable without a real Ollama
 * instance; a `show()` failure for one model returns `false` rather than
 * throwing, so it never sinks a caller looping over many models.
 */
export async function hasOllamaVisionCapability(
  client: Pick<Ollama, 'show'>,
  modelName: string,
): Promise<boolean> {
  try {
    const info = await client.show({ model: modelName });
    return info.capabilities?.includes('vision') ?? false;
  } catch {
    return false;
  }
}

/**
 * Hand-maintained last-resort table for OpenAI/Anthropic models whose
 * exact id isn't (yet) covered by LangChain's own per-package ModelProfile
 * data. Starts empty — entries are added only as specific gaps are found,
 * never populated speculatively. Not consulted for Ollama, which always
 * uses the live check above instead.
 */
export const FALLBACK_VISION_CAPABILITIES: Record<
  ProviderConfig['type'],
  Record<string, boolean>
> = {
  ollama: {},
  openai: {},
  anthropic: {},
};

/**
 * Pure version of resolveVisionCapability() — accepts an explicit
 * ProviderConfig rather than resolving one from the live env, same split
 * as createProviderFromConfig()/createProvider() above. This is what's
 * actually unit-testable; resolveVisionCapability() is a thin env-resolving
 * wrapper around this for real callers (mirrors createProvider()).
 *
 * Ollama uses the live capabilities check above; OpenAI/Anthropic use
 * LangChain's beta `.profile.imageInputs` (camelCase — the real
 * @langchain/core@1.2.2 field name), then an openai-type provider's own
 * `labels` field (if the caller passed one in via `rawDetails` — see
 * RawModelDetails/fetchModelDetails above, e.g. Lemonade's "vision" label),
 * with FALLBACK_VISION_CAPABILITIES as a last resort. Never throws: a
 * misconfigured provider (e.g. Anthropic with no resolvable apiKey, which
 * throws synchronously at construction) or an unknown model both resolve to
 * `false` — the conservative default, since sending unsupported content is
 * worse than an unnecessary warning.
 */
export async function resolveVisionCapabilityFromConfig(
  providerConfig: ProviderConfig,
  modelId: string,
  rawDetails?: RawModelDetails,
): Promise<boolean> {
  if (providerConfig.type === 'ollama') {
    const client = new Ollama({ host: providerConfig.baseUrl });
    return hasOllamaVisionCapability(client, modelId);
  }

  try {
    const llm = createProviderFromConfig(providerConfig, modelId);
    return (
      llm.profile?.imageInputs ??
      rawDetails?.labels?.includes('vision') ??
      FALLBACK_VISION_CAPABILITIES[providerConfig.type][modelId] ??
      false
    );
  } catch {
    return false;
  }
}

/**
 * Resolves whether a given provider/model combination (looked up by
 * provider name against the live env config, same fallback chain as
 * createProvider()) accepts image input. See
 * resolveVisionCapabilityFromConfig() for the actual logic. For an
 * openai-type provider, does its own one-off fetchModelDetails() call to
 * find the model's raw labels — proportionate here since this only runs
 * once per attachment-bearing turn, unlike GET /api/v1/providers's listing
 * loop (providers.route.ts), which fetches details once per provider up
 * front and passes them in directly to avoid refetching per model.
 */
export async function resolveVisionCapability(
  providerName: string | undefined,
  modelId: string,
): Promise<boolean> {
  let providerConfig: ProviderConfig;
  try {
    providerConfig = resolveProviderConfig(providerName);
  } catch {
    return false;
  }

  let rawDetails: RawModelDetails | undefined;
  if (providerConfig.type === 'openai') {
    const details = await fetchModelDetails(providerConfig);
    rawDetails = details.find((d) => d.id === modelId);
  }

  return resolveVisionCapabilityFromConfig(providerConfig, modelId, rawDetails);
}
