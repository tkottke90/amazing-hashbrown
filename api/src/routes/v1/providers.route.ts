import { Router } from 'express';
import { Ollama } from 'ollama';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { env, type ProviderConfig } from '../../config/env.js';

export const providersRouter = Router();

async function listModels(provider: ProviderConfig): Promise<string[]> {
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

providersRouter.get('/', async (_req, res) => {
  const providers = env.providers;

  const results = await Promise.all(
    providers.map(async (p) => ({
      name: p.name,
      type: p.type,
      defaultModel: p.defaultModel,
      models: await listModels(p),
    })),
  );

  res.json({ providers: results });
});
