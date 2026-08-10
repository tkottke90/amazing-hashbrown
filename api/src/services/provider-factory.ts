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
      return new ChatAnthropic({ model: resolvedModel, apiKey: config.apiKey });
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

export function createProvider(name?: string, model?: string): BaseChatModel {
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

  return createProviderFromConfig(providerConfig, model);
}
