export type CanonicalState = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface AuthField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
}

export interface Tracker {
  type: string;
  displayName: string;
  icon: string;
  canCreate: boolean;
  authSchema: AuthField[];
}

export interface TrackerItem {
  id: string;
  url: string;
  title: string;
  state: CanonicalState;
  trackerState: string;
}

export interface GithubVerifyResult {
  valid: boolean;
  scopes: string[];
  canCreate: boolean;
  tokenType: 'classic' | 'fine-grained' | 'unknown';
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listTrackers(): Promise<Tracker[]> {
  return request<Tracker[]>('/api/v1/trackers');
}

export async function resolveTrackerUrl(type: string, url: string): Promise<TrackerItem> {
  return request<TrackerItem>(`/api/v1/trackers/${type}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

export async function getTrackerItem(type: string, id: string): Promise<TrackerItem> {
  return request<TrackerItem>(`/api/v1/trackers/${type}/items?id=${encodeURIComponent(id)}`);
}

export async function createTrackerItem(
  type: string,
  params: { title: string; body?: string; repo?: string },
): Promise<TrackerItem> {
  return request<TrackerItem>(`/api/v1/trackers/${type}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function verifyGithubToken(token: string): Promise<GithubVerifyResult> {
  return request<GithubVerifyResult>('/api/v1/trackers/github/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}
