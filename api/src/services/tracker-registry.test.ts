import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  TrackerRegistry,
  bootTrackerRegistry,
  getTrackerRegistry,
  resolveTrackerUrlAnyAdapter,
} from './tracker-registry.js';
import type { TrackerAdapter } from './tracker-adapter.js';

function fakeAdapter(type: string, overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    type,
    displayName: type,
    icon: '<svg></svg>',
    authSchema: [],
    canCreate: false,
    resolveUrl: async () => {
      throw new Error('not implemented');
    },
    getItem: async () => {
      throw new Error('not implemented');
    },
    createItem: async () => {
      throw new Error('not implemented');
    },
    updateState: async () => {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

describe('services/tracker-registry', () => {
  describe('TrackerRegistry', () => {
    it('register() then get() returns the same adapter', () => {
      const registry = new TrackerRegistry();
      const adapter = fakeAdapter('fake');
      registry.register(adapter);
      expect(registry.get('fake')).to.equal(adapter);
    });

    it('get() returns undefined for an unregistered type', () => {
      const registry = new TrackerRegistry();
      expect(registry.get('missing')).to.equal(undefined);
    });

    it('list() returns all registered adapters', () => {
      const registry = new TrackerRegistry();
      registry.register(fakeAdapter('a'));
      registry.register(fakeAdapter('b'));
      expect(registry.list().map((a) => a.type)).to.have.members(['a', 'b']);
    });

    it('register() with an existing type overwrites the previous adapter', () => {
      const registry = new TrackerRegistry();
      const first = fakeAdapter('dup');
      const second = fakeAdapter('dup');
      registry.register(first);
      registry.register(second);
      expect(registry.list()).to.have.length(1);
      expect(registry.get('dup')).to.equal(second);
    });
  });

  describe('resolveTrackerUrlAnyAdapter()', () => {
    it('returns the first adapter whose resolveUrl() resolves', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter('a', {
          resolveUrl: async () => {
            throw new Error('wrong host');
          },
        }),
      );
      registry.register(
        fakeAdapter('b', {
          resolveUrl: async (url) => ({
            id: 'owner/repo#1',
            url,
            title: 'Found it',
            state: 'pending',
            trackerState: 'open',
          }),
        }),
      );

      const result = await resolveTrackerUrlAnyAdapter(registry, 'https://example.com/issues/1');
      expect(result.type).to.equal('b');
      expect(result.item.title).to.equal('Found it');
    });

    it('is order-independent — the matching adapter is found regardless of registration order', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter('b', {
          resolveUrl: async (url) => ({
            id: 'owner/repo#1',
            url,
            title: 'Found it',
            state: 'pending',
            trackerState: 'open',
          }),
        }),
      );
      registry.register(
        fakeAdapter('a', {
          resolveUrl: async () => {
            throw new Error('wrong host');
          },
        }),
      );

      const result = await resolveTrackerUrlAnyAdapter(registry, 'https://example.com/issues/1');
      expect(result.type).to.equal('b');
    });

    it('rejects naming the url and every attempted adapter when none resolve', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        fakeAdapter('a', {
          resolveUrl: async () => {
            throw new Error('wrong host');
          },
        }),
      );
      registry.register(
        fakeAdapter('b', {
          resolveUrl: async () => {
            throw new Error('404');
          },
        }),
      );

      try {
        await resolveTrackerUrlAnyAdapter(registry, 'https://nope.example.com/1');
        expect.fail('expected resolveTrackerUrlAnyAdapter to reject');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).to.include('https://nope.example.com/1');
        expect(message).to.include('a: wrong host');
        expect(message).to.include('b: 404');
      }
    });

    it('rejects with a distinct message when no adapters are registered at all', async () => {
      const registry = new TrackerRegistry();
      try {
        await resolveTrackerUrlAnyAdapter(registry, 'https://example.com/1');
        expect.fail('expected resolveTrackerUrlAnyAdapter to reject');
      } catch (err) {
        expect((err as Error).message).to.include('no tracker adapters are registered');
      }
    });
  });

  describe('bootTrackerRegistry()', () => {
    const originalPlugins = process.env['TRACKER_PLUGINS'];

    afterEach(() => {
      if (originalPlugins === undefined) delete process.env['TRACKER_PLUGINS'];
      else process.env['TRACKER_PLUGINS'] = originalPlugins;
    });

    it('always registers the built-in GitHub adapter', () => {
      delete process.env['TRACKER_PLUGINS'];
      bootTrackerRegistry();
      const github = getTrackerRegistry().get('github');
      expect(github, 'github adapter not registered').to.not.equal(undefined);
      expect(github!.displayName).to.equal('GitHub');
    });

    it('loads an external adapter listed in TRACKER_PLUGINS', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tracker-plugin-'));
      const pluginPath = join(dir, 'plugin.cjs');
      writeFileSync(
        pluginPath,
        `module.exports = {
          type: 'fake-plugin',
          displayName: 'Fake Plugin',
          icon: '<svg></svg>',
          authSchema: [],
          canCreate: false,
          resolveUrl: async () => { throw new Error('n/a'); },
          getItem: async () => { throw new Error('n/a'); },
          createItem: async () => { throw new Error('n/a'); },
          updateState: async () => { throw new Error('n/a'); },
        };`,
      );
      process.env['TRACKER_PLUGINS'] = pluginPath;

      try {
        bootTrackerRegistry();
        const plugin = getTrackerRegistry().get('fake-plugin');
        expect(plugin, 'external plugin not registered').to.not.equal(undefined);
        expect(plugin!.displayName).to.equal('Fake Plugin');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not throw and still registers the built-in adapter when a plugin fails to load', () => {
      process.env['TRACKER_PLUGINS'] = '/nonexistent/path/to/plugin.js';
      expect(() => bootTrackerRegistry()).to.not.throw();
      expect(getTrackerRegistry().get('github')).to.not.equal(undefined);
    });
  });
});
