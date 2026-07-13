import { Router } from 'express';
import { env } from '../../config/env.js';

export const providersRouter = Router();

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

providersRouter.get('/', async (_req, res) => {
  const providers = env.providers;

  const results = await Promise.all(
    providers.map(async (p) => {
      let models: string[] = [];

      if (p.type === 'ollama') {
        models = await fetchOllamaModels(p.baseUrl ?? 'http://localhost:11434');
      } else if (p.defaultModel) {
        models = [p.defaultModel];
      }

      return {
        name: p.name,
        type: p.type,
        defaultModel: p.defaultModel,
        models,
      };
    }),
  );

  res.json({ providers: results });
});
