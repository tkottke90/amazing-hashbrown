export interface ListProviderModelsRequest {
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  // Resolves a masked ('****') apiKey against a saved provider by name —
  // mutually exclusive with `source`.
  name?: string;
  // Resolves a masked apiKey against the embeddings section's own stored
  // key — used by the embeddings panel, which isn't a saved provider.
  source?: 'embeddings';
  // Filters the result to embedding-capable models.
  capability?: 'embedding';
}

export async function listProviderModels(req: ListProviderModelsRequest): Promise<string[]> {
  const res = await fetch('/api/v1/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: { models: string[] };
    error?: string;
  };

  if (!res.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error ?? `Failed to list models: ${res.status}`);
  }

  return payload.data.models;
}
