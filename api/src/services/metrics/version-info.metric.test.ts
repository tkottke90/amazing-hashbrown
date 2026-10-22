import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { versionInfoMetric } from './version-info.metric.js';

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function fakeFetchImpl(response: FakeResponse | (() => Promise<FakeResponse>)): typeof fetch {
  return (async () =>
    typeof response === 'function' ? await response() : response) as unknown as typeof fetch;
}

function makeDeps(checkForUpdates: boolean, fetchImpl?: typeof fetch): MetricDeps {
  return {
    workspaceStore: {} as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates,
    fetchImpl,
  };
}

describe('services/metrics/version-info.metric', () => {
  const originalAppVersion = process.env['APP_VERSION'];
  const originalCommitSha = process.env['COMMIT_SHA'];

  beforeEach(() => {
    process.env['APP_VERSION'] = '1.2.3';
    process.env['COMMIT_SHA'] = 'abcdef1234567890';
  });

  afterEach(() => {
    if (originalAppVersion === undefined) delete process.env['APP_VERSION'];
    else process.env['APP_VERSION'] = originalAppVersion;
    if (originalCommitSha === undefined) delete process.env['COMMIT_SHA'];
    else process.env['COMMIT_SHA'] = originalCommitSha;
  });

  it('returns the static fallback and never calls fetch when checkForUpdates is false [unit]', async () => {
    let fetchCalled = false;
    const fetchImpl = fakeFetchImpl(() => {
      fetchCalled = true;
      throw new Error('should not be called');
    });

    const result = await versionInfoMetric.resolve(makeDeps(false, fetchImpl));

    expect(fetchCalled).to.equal(false);
    expect(result.displayType).to.equal('markdown');
    if (result.displayType === 'markdown') {
      expect(result.content).to.include('**Version:** 1.2.3 (`abcdef1`)');
      expect(result.content).to.include('[View Releases]');
    }
  });

  it('shows a newer-version notice when the latest release tag differs from APP_VERSION [unit]', async () => {
    const fetchImpl = fakeFetchImpl({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v9.9.9',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/tkottke90/amazing-hashbrown/releases/tag/v9.9.9',
      }),
    });

    const result = await versionInfoMetric.resolve(makeDeps(true, fetchImpl));

    expect(result.displayType).to.equal('markdown');
    if (result.displayType === 'markdown') {
      expect(result.content).to.include('Newer version available: **v9.9.9**');
      expect(result.content).to.include('released 2026-01-01');
    }
  });

  it('shows "Up to date" when the latest release tag matches APP_VERSION [unit]', async () => {
    const fetchImpl = fakeFetchImpl({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.2.3',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/tkottke90/amazing-hashbrown/releases/tag/v1.2.3',
      }),
    });

    const result = await versionInfoMetric.resolve(makeDeps(true, fetchImpl));

    expect(result.displayType).to.equal('markdown');
    if (result.displayType === 'markdown') expect(result.content).to.include('✅ Up to date');
  });

  it('falls back to the static content when the fetch itself rejects [unit]', async () => {
    const fetchImpl = (async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    const result = await versionInfoMetric.resolve(makeDeps(true, fetchImpl));

    expect(result.displayType).to.equal('markdown');
    if (result.displayType === 'markdown') expect(result.content).to.include('[View Releases]');
  });

  it('falls back to the static content when the GitHub API responds not-ok [unit]', async () => {
    const fetchImpl = fakeFetchImpl({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await versionInfoMetric.resolve(makeDeps(true, fetchImpl));

    expect(result.displayType).to.equal('markdown');
    if (result.displayType === 'markdown') expect(result.content).to.include('[View Releases]');
  });
});
