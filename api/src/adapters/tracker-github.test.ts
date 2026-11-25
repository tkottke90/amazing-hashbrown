import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createGithubTrackerAdapter } from './tracker-github.js';

// Targets the GitHub REST API (2022-11-28) issue shapes.

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responseBody), { status });
  }) as typeof fetch;
  return calls;
}

const ISSUE = {
  number: 7,
  html_url: 'https://github.com/octo/repo/issues/7',
  title: 'A bug',
  state: 'open',
};

describe('adapters/tracker-github', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is always configured, so public issues can be linked without a token [unit]', () => {
    expect(createGithubTrackerAdapter(undefined).configured).to.equal(true);
  });

  it('creates the issue in the repo named by the container param [external-orchestration]', async () => {
    const calls = mockFetch(ISSUE, 201);
    const adapter = createGithubTrackerAdapter('ghp_test');
    await adapter.createItem({ title: 'A bug', body: 'Steps', container: 'octo/repo' });
    expect(calls).to.have.length(1);
    expect(calls[0]!.method).to.equal('POST');
    expect(calls[0]!.url).to.equal('https://api.github.com/repos/octo/repo/issues');
    expect(calls[0]!.body).to.deep.equal({ title: 'A bug', body: 'Steps' });
  });

  it('rejects a create with no container, since GitHub has no default repo [unit]', async () => {
    const adapter = createGithubTrackerAdapter('ghp_test');
    let message = '';
    try {
      await adapter.createItem({ title: 'A bug' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.contain('repo is required');
  });

  it('reports dueAt as null because GitHub issues have no due date [external-orchestration]', async () => {
    mockFetch(ISSUE);
    const item = await createGithubTrackerAdapter(undefined).getItem('octo/repo#7');
    expect(item.dueAt).to.equal(null);
    expect(item.state).to.equal('pending');
  });
});
