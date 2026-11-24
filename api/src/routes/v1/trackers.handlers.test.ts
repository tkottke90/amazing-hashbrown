import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { TrackerRegistry } from '../../services/tracker-registry.js';
import type { TrackerAdapter, TrackerItem } from '../../services/tracker-adapter.js';
import {
  listTrackersHandler,
  resolveTrackerUrlHandler,
  getTrackerItemHandler,
  createTrackerItemHandler,
  listTrackerContainersHandler,
  verifyGithubTokenHandler,
} from './trackers.handlers.js';

const SAMPLE_ITEM: TrackerItem = {
  id: 'octo/repo#1',
  url: 'https://github.com/octo/repo/issues/1',
  title: 'Sample issue',
  state: 'pending',
  trackerState: 'open',
  dueAt: null,
};

function fakeAdapter(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    type: 'fake',
    displayName: 'Fake',
    icon: '<svg></svg>',
    authSchema: [],
    canCreate: false,
    configured: true,
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
      registry.register(
        fakeAdapter({ type: 'fake', displayName: 'Fake', canCreate: true, configured: false }),
      );
      const result = listTrackersHandler(registry);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([
          {
            type: 'fake',
            displayName: 'Fake',
            icon: '<svg></svg>',
            canCreate: true,
            configured: false,
            authSchema: [],
          },
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
      const result = await resolveTrackerUrlHandler(registry, 'fake', {
        url: 'https://example.com',
      });
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
        container: 'octo/repo',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal(SAMPLE_ITEM);
    });

    it('passes title, body, container and dueAt through to the adapter unchanged [unit]', async () => {
      const registry = new TrackerRegistry();
      const received: unknown[] = [];
      registry.register(
        fakeAdapter({
          canCreate: true,
          createItem: async (params) => {
            received.push(params);
            return SAMPLE_ITEM;
          },
        }),
      );
      await createTrackerItemHandler(registry, 'fake', {
        title: 'New task',
        body: 'Details',
        container: 'proj-1',
        dueAt: '2026-12-01',
      });
      expect(received, 'adapter should receive the create params as sent').to.deep.equal([
        { title: 'New task', body: 'Details', container: 'proj-1', dueAt: '2026-12-01' },
      ]);
    });

    it('treats an empty container as "use the adapter default" rather than an empty id [unit]', async () => {
      const registry = new TrackerRegistry();
      const received: Array<{ container?: string }> = [];
      registry.register(
        fakeAdapter({
          canCreate: true,
          createItem: async (params) => {
            received.push(params);
            return SAMPLE_ITEM;
          },
        }),
      );
      await createTrackerItemHandler(registry, 'fake', { title: 'x', container: '' });
      expect(received[0]!.container).to.equal(undefined);
    });

    it('rejects a dueAt that is not a YYYY-MM-DD date with 400, without calling the adapter [unit]', async () => {
      const registry = new TrackerRegistry();
      let called = false;
      registry.register(
        fakeAdapter({
          canCreate: true,
          createItem: async () => {
            called = true;
            return SAMPLE_ITEM;
          },
        }),
      );
      const result = await createTrackerItemHandler(registry, 'fake', {
        title: 'x',
        dueAt: 'next tuesday',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
      expect(called, 'an invalid dueAt must not reach the tracker').to.equal(false);
    });
  });

  describe('listTrackerContainersHandler()', () => {
    it('returns 404 for an unregistered tracker type [unit]', async () => {
      const result = await listTrackerContainersHandler(new TrackerRegistry(), 'missing');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when the adapter does not list containers, so the UI falls back to free text [unit]', async () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter());
      const result = await listTrackerContainersHandler(registry, 'fake');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it("returns the adapter's containers on success [unit]", async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter({ listContainers: async () => [{ id: 'p1', name: 'Personal' }] }),
      );
      const result = await listTrackerContainersHandler(registry, 'fake');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([{ id: 'p1', name: 'Personal' }]);
    });

    it('returns 500 with the adapter error message when listing fails [unit]', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter({
          listContainers: async () => {
            throw new Error('Todoist API error 503');
          },
        }),
      );
      const result = await listTrackerContainersHandler(registry, 'fake');
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(500);
        expect(result.error).to.contain('503');
      }
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
        new Response('{}', {
          status: 200,
          headers: { 'x-oauth-scopes': 'repo, read:user' },
        })) as typeof fetch;

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
        new Response('{}', {
          status: 200,
          headers: { 'x-oauth-scopes': 'read:user' },
        })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_readonly' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(true);
        expect(result.data.canCreate).to.equal(false);
      }
    });

    it('reports canCreate: true and tokenType "fine-grained" for a github_pat_ token with no scopes header', async () => {
      globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'github_pat_fake' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.valid).to.equal(true);
        expect(result.data.tokenType).to.equal('fine-grained');
        expect(result.data.canCreate).to.equal(true);
        expect(result.data.scopes).to.deep.equal([]);
      }
    });

    it('reports tokenType "classic" when an X-OAuth-Scopes header is present', async () => {
      globalThis.fetch = (async () =>
        new Response('{}', {
          status: 200,
          headers: { 'x-oauth-scopes': 'repo' },
        })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'ghp_valid' });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.tokenType).to.equal('classic');
    });

    it('reports canCreate: false and tokenType "unknown" for an unrecognised token shape with no scopes', async () => {
      globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

      const result = await verifyGithubTokenHandler({ token: 'some-other-token-shape' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.tokenType).to.equal('unknown');
        expect(result.data.canCreate).to.equal(false);
      }
    });

    it('reports valid: false with an error when GitHub rejects the token', async () => {
      globalThis.fetch = (async () =>
        new Response('bad credentials', { status: 401 })) as typeof fetch;

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
