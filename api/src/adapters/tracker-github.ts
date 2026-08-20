import type { AuthField, CanonicalState, TrackerAdapter, TrackerItem } from '../services/tracker-adapter.js';

const GITHUB_API = 'https://api.github.com';

const ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/;
const ID_RE = /^([^/]+)\/([^/]+)#(\d+)$/;

interface GithubIssue {
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  pull_request?: unknown;
}

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const AUTH_SCHEMA: AuthField[] = [
  { key: 'token', label: 'Personal access token', type: 'password', required: false },
];

function toCanonicalState(issue: GithubIssue): CanonicalState {
  return issue.state === 'closed' ? 'done' : 'pending';
}

function toTrackerItem(owner: string, repo: string, num: string, issue: GithubIssue): TrackerItem {
  return {
    id: `${owner}/${repo}#${num}`,
    url: issue.html_url,
    title: issue.title,
    state: toCanonicalState(issue),
    trackerState: issue.state,
  };
}

export function createGithubTrackerAdapter(token?: string): TrackerAdapter {
  const canCreate = Boolean(token);

  function headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async function fetchIssue(owner: string, repo: string, num: string): Promise<GithubIssue> {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${num}`, {
      headers: headers(),
    });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as GithubIssue;
  }

  return {
    type: 'github',
    displayName: 'GitHub',
    icon: GITHUB_ICON,
    authSchema: AUTH_SCHEMA,
    canCreate,

    async resolveUrl(url: string): Promise<TrackerItem> {
      const match = ISSUE_URL_RE.exec(url.trim());
      if (!match) throw new Error('Not a recognised GitHub issue or pull request URL');
      const [, owner, repo, , num] = match as unknown as [string, string, string, string, string];
      const issue = await fetchIssue(owner, repo, num);
      return toTrackerItem(owner, repo, num, issue);
    },

    async getItem(id: string): Promise<TrackerItem> {
      const match = ID_RE.exec(id);
      if (!match) throw new Error(`Invalid GitHub tracker id: "${id}"`);
      const [, owner, repo, num] = match as unknown as [string, string, string, string];
      const issue = await fetchIssue(owner, repo, num);
      return toTrackerItem(owner, repo, num, issue);
    },

    async createItem(params: { title: string; body?: string; repo?: string }): Promise<TrackerItem> {
      if (!canCreate) throw new Error('GitHub adapter is not configured for creating issues');
      if (!params.repo) throw new Error('repo is required to create a GitHub issue');
      const [owner, repo] = params.repo.split('/');
      if (!owner || !repo) throw new Error(`Invalid repo "${params.repo}", expected "owner/repo"`);
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: params.title, body: params.body }),
      });
      if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
      }
      const issue = (await res.json()) as GithubIssue & { number: number };
      return toTrackerItem(owner, repo, String(issue.number), issue);
    },

    async updateState(): Promise<TrackerItem> {
      throw new Error('updateState is not supported by the GitHub tracker adapter yet');
    },
  };
}
