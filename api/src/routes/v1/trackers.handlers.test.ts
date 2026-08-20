import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { TrackerRegistry } from '../../services/tracker-registry.js';
import type { TrackerAdapter, TrackerItem } from '../../services/tracker-adapter.js';
import {
  listTrackersHandler,
  resolveTrackerUrlHandler,
  getTrackerItemHandler,
  createTrackerItemHandler,
  verifyGithubTokenHandler,
} from './trackers.handlers.js';

const SAMPLE_ITEM: TrackerItem = {
  id: 'octo/repo#1',
  url: 'https://github.com/octo/repo/issues/1',
  title: 'Sample issue',
  state: 'pending',
  trackerState: 'open',
};

function fakeAdapter(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    type: 'fake',
    displayName: 'Fake',
    icon: '<svg></svg>',
    authSchema: [],
    canCreate: false,
    resolveUrl: async () => SAMPLE_ITEM,
    getItem: async () => SAMPLE_ITEM,
    createItem: async () => SAMPLE_ITEM,
    updateState: async () => SAMPLE_ITEM,
    ...overrides,
  };
}

describe('routes/v1/trackers.handlers', () => {
  describe('listTrackersHandler()', () => {
    it('maps registered adapters to their public summary shape', () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter({ type: 'fake', displayName: 'Fake', canCreate: true }));
      const result = listTrackersHandler(registry);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([
          { type: 'fake', displayName: 'Fake', icon: '<svg></svg>', canCreate: true, authSchema: [] },
        ]);
      }
    });
  });

  describe('resolveTrackerUrlHandler()', () => {
    it('returns 404 for an unregistered type', async () => {
      const registry = new TrackerRegistry();
      const result = await resolveTrackerUrlHandler(registry, 'missing', { url: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when url is missing', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter());
      const result = await resolveTrackerUrlHandler(registry, 'fake', {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when the adapter rejects the url', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter({
          resolveUrl: async () => {
            throw new Error('Not a recognised URL');
          },
        }),
      );
      const result = await resolveTrackerUrlHandler(registry, 'fake', { url: 'https://example.com' });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.equal('Not a recognised URL');
      }
    });

    it('returns the resolved item on success', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter());
      const result = await resolveTrackerUrlHandler(registry, 'fake', {
        url: 'https://github.com/octo/repo/issues/1',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal(SAMPLE_ITEM);
    });
  });

  describe('getTrackerItemHandler()', () => {
    it('returns 404 for an unregistered type', async () => {
      const registry = new TrackerRegistry();
      const result = await getTrackerItemHandler(registry, 'missing', 'octo/repo#1');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 when the adapter cannot find the item', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter({
          getItem: async () => {
            throw new Error('GitHub API error 404');
          },
        }),
      );
      const result = await getTrackerItemHandler(registry, 'fake', 'octo/repo#999');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns the item on success', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter());
      const result = await getTrackerItemHandler(registry, 'fake', 'octo/repo#1');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal(SAMPLE_ITEM);
    });
  });

  describe('createTrackerItemHandler()', () => {
    it('returns 404 for an unregistered type', async () => {
      const registry = new TrackerRegistry();
      const result = await createTrackerItemHandler(registry, 'missing', { title: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when the adapter cannot create (Option A / link-only)', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter({ canCreate: false }));
      const result = await createTrackerItemHandler(registry, 'fake', { title: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when title is missing', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter({ canCreate: true }));
      const result = await createTrackerItemHandler(registry, 'fake', {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('creates and returns the item on success', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter({ canCreate: true }));
      const result = await createTrackerItemHandler(registry, 'fake', {
        title: 'New issue',
        repo: 'octo/repo',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal(SAMPLE_ITEM);
    });
  });

  describe('verifyGithubTokenHandler()', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns 400 when token is missing', async () => {
      const result = await verifyGithubTokenHandler({});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('reports canCreate: true when the token has the repo scope', async () => {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo, read:user' } })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_valid' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(true);
        expect(result.data.canCreate).to.equal(true);
        expect(result.data.scopes).to.include('repo');
      }
    });

    it('reports canCreate: false when scopes lack repo/public_repo', async () => {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'read:user' } })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_readonly' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(true);
        expect(result.data.canCreate).to.equal(false);
      }
    });

    it('reports valid: false with an error when GitHub rejects the token', async () => {
      globalThis.fetch = (async () => new Response('bad credentials', { status: 401 })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_bad' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(false);
        expect(result.data.error).to.be.a('string').and.have.length.above(0);
      }
    });

    it('reports valid: false with an error when the request throws (network error)', async () => {
      globalThis.fetch = (async () => {
        throw new Error('network unreachable');
      }) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_x' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(false);
        expect(result.data.error).to.equal('network unreachable');
      }
    });
  });
});
