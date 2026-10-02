import { request } from '@/utils/fetch.utils';

export interface ApiKey {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevealedApiKey {
  id: string;
  name: string;
  key: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return request<ApiKey[]>('/api/v1/api-keys');
}

export async function createApiKey(name: string): Promise<RevealedApiKey> {
  return request<RevealedApiKey>('/api/v1/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function rotateApiKey(id: string): Promise<RevealedApiKey> {
  return request<RevealedApiKey>(`/api/v1/api-keys/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await fetch(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
