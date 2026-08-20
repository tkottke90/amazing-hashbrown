import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { TrackerRegistry, bootTrackerRegistry, getTrackerRegistry } from './tracker-registry.js';
import type { TrackerAdapter } from './tracker-adapter.js';

function fakeAdapter(type: string): TrackerAdapter {
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
