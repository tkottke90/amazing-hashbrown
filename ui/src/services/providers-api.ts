export interface ListProviderModelsRequest {
  type: 'ollama' | 'openai' | 'anthropic' | 'openai-compatible';
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
  // Only meaningful for type === 'openai-compatible' — selects between
  // apiKey above and the Client Credentials fields below for this live,
  // possibly-unsaved model-list fetch.
  authMode?: 'apiKey' | 'oidc';
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  grantType?: string;
}

export interface TestEmbeddingsRequest {
  type: 'ollama' | 'openai';
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface TestEmbeddingsResult {
  dims: number;
  durationMs: number;
}

export async function testEmbeddings(req: TestEmbeddingsRequest): Promise<TestEmbeddingsResult> {
  const res = await fetch('/api/v1/providers/embeddings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    dims?: number;
    durationMs?: number;
    error?: string;
  };

  if (!res.ok || !payload.ok || payload.dims == null) {
    throw new Error(payload.error ?? `Test failed: ${res.status}`);
  }

  return { dims: payload.dims, durationMs: payload.durationMs ?? 0 };
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

// Clears an OIDC-authenticated Provider's (Azure OpenAI, or OpenAI-Compatible
// in oidc mode) cached Access Token only — no config change. Rotate
// (replacing clientId/clientSecret) goes through the normal settings PATCH
// flow instead; see GLOSSARY.md "Revoke"/"Rotate".
export async function revokeProviderToken(name: string): Promise<void> {
  const res = await fetch(`/api/v1/providers/${encodeURIComponent(name)}/revoke`, {
    method: 'POST',
  });

  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

  if (!res.ok || !payload.ok) {
    throw new Error(payload.error ?? `Failed to revoke token: ${res.status}`);
  }
}

export interface TestOidcTokenRequest {
  // Resolves a masked ('****') clientSecret against this saved provider's
  // stored secret — set when editing an existing OIDC-authenticated
  // provider; omitted for a brand-new, unsaved one.
  providerName?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  grantType?: string;
}

// Verifies OIDC Client Credentials against the live IdP — a one-off
// fetch-and-discard the provider-edit modal uses to let the user confirm
// credentials work before Save, without writing anything or touching the
// persistent Access Token cache.
export async function testOidcToken(
  req: TestOidcTokenRequest,
): Promise<{ expiresInSeconds: number }> {
  const res = await fetch('/api/v1/providers/test-oidc-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    expiresInSeconds?: number;
    error?: string;
  };

  if (!res.ok || !payload.ok || payload.expiresInSeconds == null) {
    throw new Error(payload.error ?? `Failed to verify credentials: ${res.status}`);
  }

  return { expiresInSeconds: payload.expiresInSeconds };
}
