import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toolsManager, bootToolsManager } from './tools-manager.js';

// The module registers ask_user and upload_image at load time (before boot()).
// list() does not require boot() — it reads the in-memory builtin registry.

describe('services/tools-manager', () => {
  describe('built-in registrations', () => {
    it('registers ask_user with source "builtin"', () => {
      const tool = toolsManager.list().find((t) => t.name === 'ask_user');
      expect(tool, 'ask_user not found in registry').to.exist;
      expect(tool!.source).to.equal('builtin');
    });

    it('registers upload_image with source "builtin"', () => {
      const tool = toolsManager.list().find((t) => t.name === 'upload_image');
      expect(tool, 'upload_image not found in registry').to.exist;
      expect(tool!.source).to.equal('builtin');
    });

    it('ask_user has a non-empty description', () => {
      const tool = toolsManager.list().find((t) => t.name === 'ask_user')!;
      expect(tool.description).to.be.a('string').and.have.length.above(0);
    });

    it('upload_image has a non-empty description', () => {
      const tool = toolsManager.list().find((t) => t.name === 'upload_image')!;
      expect(tool.description).to.be.a('string').and.have.length.above(0);
    });

    it('registers exactly two built-in tools (no MCP servers configured at load)', () => {
      const builtins = toolsManager.list().filter((t) => t.source === 'builtin');
      expect(builtins).to.have.length(2);
      const names = builtins.map((t) => t.name);
      expect(names).to.include.members(['ask_user', 'upload_image']);
    });
  });

  describe('bootToolsManager()', () => {
    it('resolves without throwing when no MCP servers are configured', async () => {
      // boot() is idempotent — safe to call even if a previous test already called it.
      await bootToolsManager();
    });

    it('does not evict registered builtins after boot', async () => {
      await bootToolsManager();
      const names = toolsManager.list().map((t) => t.name);
      expect(names).to.include('ask_user');
      expect(names).to.include('upload_image');
    });
  });
});
