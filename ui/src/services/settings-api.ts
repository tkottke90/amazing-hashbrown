export class SettingsValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string[]> | string) {
    super('Validation failed');
    this.name = 'SettingsValidationError';
  }
}

export async function fetchSettingsSection<T>(slug: string): Promise<T> {
  const res = await fetch(`/api/v1/settings/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Failed to fetch settings/${slug}: ${res.status}`);
  const body = (await res.json()) as { ok: true; data: T };
  return body.data;
}

export async function patchSettingsSection<T>(slug: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/v1/settings/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 400) {
    const payload = (await res.json()) as { fieldErrors?: Record<string, string[]>; error?: string };
    throw new SettingsValidationError(payload.fieldErrors ?? payload.error ?? 'Validation failed');
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Failed to patch settings/${slug}: ${res.status}`);
  }

  const result = (await res.json()) as { ok: true; data: T };
  return result.data;
}
