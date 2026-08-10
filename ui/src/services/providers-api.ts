export interface ListProviderModelsRequest {
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  name?: string;
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
