import { request } from '@/utils/fetch.utils';

export type CanonicalState = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface AuthField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  // When true, this field renders with the literal-value/env-var-reference
  // toggle (CredentialValueField) instead of a plain input.
  supportsEnvRef?: boolean;
}

export interface Tracker {
  type: string;
  displayName: string;
  icon: string;
  canCreate: boolean;
  // Whether the tracker has what it needs (e.g. a token) to answer requests.
  // Only configured trackers are offered for linking.
  configured: boolean;
  authSchema: AuthField[];
}

export interface TrackerItem {
  id: string;
  url: string;
  title: string;
  state: CanonicalState;
  trackerState: string;
  dueAt: string | null; // YYYY-MM-DD
}

// A place a new tracker item can be created in (a GitHub repo, a Todoist project).
export interface TrackerContainer {
  id: string;
  name: string;
}

export interface CreateTrackerItemParams {
  title: string;
  body?: string;
  container?: string;
  dueAt?: string | null;
}

export interface GithubVerifyResult {
  valid: boolean;
  scopes: string[];
  canCreate: boolean;
  tokenType: 'classic' | 'fine-grained' | 'unknown';
  error?: string;
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
  params: CreateTrackerItemParams,
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
