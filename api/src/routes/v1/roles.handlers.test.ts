import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import yaml from 'yaml';
import { configManager } from '../../config/env.js';
import {
  listRolesHandler,
  createRoleHandler,
  patchRoleHandler,
  deleteRoleHandler,
  setDefaultRoleHandler,
  ensureDefaultRole,
  isValidRoleName,
} from './roles.handlers.js';

describe('routes/v1/roles.handlers', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'roles-handlers-test-'));
    configManager.set('providers', [
      { name: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'llama3' },
    ]);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    configManager.set('providers', []);
  });

  function writeAgent(agent: Record<string, unknown>): void {
    writeFileSync(join(configDir, 'config.yaml'), yaml.stringify({ agent }), 'utf8');
  }

  function readAgent(): Record<string, unknown> {
    const raw = yaml.parse(readFileSync(join(configDir, 'config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    return (raw.agent as Record<string, unknown>) ?? {};
  }

  describe('isValidRoleName()', () => {
    it('accepts lowercase, hyphen-separated slugs [unit]', () => {
      expect(isValidRoleName('code-reviewer')).to.equal(true);
      expect(isValidRoleName('a')).to.equal(true);
      expect(isValidRoleName('a1-b2')).to.equal(true);
    });

    it('rejects names that are not already their own canonical slug [unit]', () => {
      expect(isValidRoleName('My Role')).to.equal(false);
      expect(isValidRoleName('role_1')).to.equal(false);
      expect(isValidRoleName('-leading')).to.equal(false);
      expect(isValidRoleName('')).to.equal(false);
    });
  });

  describe('listRolesHandler()', () => {
    it('returns configured roles and the current defaultRole [unit]', () => {
      writeAgent({ roles: { researcher: { provider: 'ollama' } }, defaultRole: 'researcher' });
      const result = listRolesHandler(configDir);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.roles).to.deep.equal([{ name: 'researcher', provider: 'ollama' }]);
      expect(result.data.defaultRole).to.equal('researcher');
    });

    it('returns an empty list and a null defaultRole when nothing is configured [unit]', () => {
      const result = listRolesHandler(configDir);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.roles).to.deep.equal([]);
      expect(result.data.defaultRole).to.equal(null);
    });
  });

  describe('createRoleHandler()', () => {
    it('creates a role and preserves sibling agent fields [unit]', () => {
      writeAgent({ recursionLimit: 42, roles: {} });
      const result = createRoleHandler(
        { name: 'reviewer', provider: 'ollama', model: 'llama3' },
        configDir,
      );
      expect(result.ok).to.equal(true);
      const agent = readAgent();
      expect(agent['recursionLimit']).to.equal(42);
      expect((agent['roles'] as Record<string, unknown>)['reviewer']).to.deep.equal({
        provider: 'ollama',
        model: 'llama3',
      });
    });

    it('calls reload after a successful write [unit]', () => {
      let reloaded = false;
      createRoleHandler({ name: 'reviewer' }, configDir, () => {
        reloaded = true;
      });
      expect(reloaded).to.equal(true);
    });

    it('rejects a duplicate name [unit]', () => {
      writeAgent({ roles: { reviewer: {} } });
      const result = createRoleHandler({ name: 'reviewer' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.fieldErrors?.['name']).to.exist;
    });

    it('rejects an invalid slug name [unit]', () => {
      const result = createRoleHandler({ name: 'My Role' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });

    it('rejects a provider that is not configured [unit]', () => {
      const result = createRoleHandler({ name: 'reviewer', provider: 'not-real' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.fieldErrors?.['provider']).to.exist;
    });
  });

  describe('patchRoleHandler()', () => {
    it('updates fields on an existing role [unit]', () => {
      writeAgent({ roles: { reviewer: { provider: 'ollama' } } });
      const result = patchRoleHandler('reviewer', { model: 'llama3' }, configDir);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data).to.deep.equal({ name: 'reviewer', provider: 'ollama', model: 'llama3' });
    });

    it('clears a field when it is explicitly set to null [unit]', () => {
      writeAgent({ roles: { reviewer: { provider: 'ollama', model: 'llama3' } } });
      const result = patchRoleHandler('reviewer', { provider: null }, configDir);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data).to.deep.equal({ name: 'reviewer', model: 'llama3' });
    });

    it('renames a role (deletes old key, inserts new) [unit]', () => {
      writeAgent({ roles: { reviewer: { provider: 'ollama' } } });
      const result = patchRoleHandler('reviewer', { name: 'senior-reviewer' }, configDir);
      expect(result.ok).to.equal(true);
      const agent = readAgent();
      const roles = agent['roles'] as Record<string, unknown>;
      expect(roles['reviewer']).to.equal(undefined);
      expect(roles['senior-reviewer']).to.deep.equal({ provider: 'ollama' });
    });

    it('carries defaultRole forward when renaming the current Default [unit]', () => {
      writeAgent({ roles: { reviewer: {} }, defaultRole: 'reviewer' });
      patchRoleHandler('reviewer', { name: 'senior-reviewer' }, configDir);
      expect(readAgent()['defaultRole']).to.equal('senior-reviewer');
    });

    it('rejects a rename onto an existing name [unit]', () => {
      writeAgent({ roles: { reviewer: {}, researcher: {} } });
      const result = patchRoleHandler('reviewer', { name: 'researcher' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });

    it('returns 404 for an unknown name [unit]', () => {
      writeAgent({ roles: {} });
      const result = patchRoleHandler('nope', { model: 'x' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('rejects a provider that is not configured [unit]', () => {
      writeAgent({ roles: { reviewer: {} } });
      const result = patchRoleHandler('reviewer', { provider: 'not-real' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });
  });

  describe('deleteRoleHandler()', () => {
    it('deletes a role [unit]', () => {
      writeAgent({ roles: { reviewer: {}, researcher: {} } });
      const result = deleteRoleHandler('reviewer', configDir);
      expect(result.ok).to.equal(true);
      const roles = readAgent()['roles'] as Record<string, unknown>;
      expect(roles['reviewer']).to.equal(undefined);
      expect(roles['researcher']).to.exist;
    });

    it('rejects deleting the last remaining role, even when it is not the Default [unit]', () => {
      writeAgent({ roles: { reviewer: {} } });
      const result = deleteRoleHandler('reviewer', configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(readAgent()['roles']).to.deep.equal({ reviewer: {} });
    });

    it('clears defaultRole, without auto-promoting another role, when deleting a non-last Default [unit]', () => {
      writeAgent({ roles: { reviewer: {}, researcher: {} }, defaultRole: 'reviewer' });
      const result = deleteRoleHandler('reviewer', configDir);
      expect(result.ok).to.equal(true);
      expect(readAgent()['defaultRole']).to.equal(undefined);
    });

    it('returns 404 for an unknown name [unit]', () => {
      writeAgent({ roles: { reviewer: {} } });
      const result = deleteRoleHandler('nope', configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });
  });

  describe('setDefaultRoleHandler()', () => {
    it('sets the default role [unit]', () => {
      writeAgent({ roles: { reviewer: {} } });
      const result = setDefaultRoleHandler({ name: 'reviewer' }, configDir);
      expect(result.ok).to.equal(true);
      expect(readAgent()['defaultRole']).to.equal('reviewer');
    });

    it('returns 404 for a name that is not configured [unit]', () => {
      writeAgent({ roles: {} });
      const result = setDefaultRoleHandler({ name: 'nope' }, configDir);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });
  });

  describe('ensureDefaultRole()', () => {
    it('backfills a single default role and sets it as defaultRole when none exist [unit]', () => {
      let reloaded = false;
      ensureDefaultRole(configDir, () => {
        reloaded = true;
      });
      const agent = readAgent();
      expect(agent['roles']).to.deep.equal({ default: {} });
      expect(agent['defaultRole']).to.equal('default');
      expect(reloaded).to.equal(true);
    });

    it('is a no-op when at least one role already exists [unit]', () => {
      writeAgent({ roles: { reviewer: {} }, defaultRole: 'reviewer' });
      let reloaded = false;
      ensureDefaultRole(configDir, () => {
        reloaded = true;
      });
      expect(readAgent()).to.deep.equal({ roles: { reviewer: {} }, defaultRole: 'reviewer' });
      expect(reloaded).to.equal(false);
    });
  });
});
