import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { Ollama } from 'ollama';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { env, type ProviderConfig } from '../config/env.js';
import { logger } from '../config/logger.js';

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

export async function listModels(provider: ProviderConfig): Promise<string[]> {
  try {
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
  } catch {
    return [];
  }
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
