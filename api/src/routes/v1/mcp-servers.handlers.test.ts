import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { ToolsManager } from '@tkottke90/tools-manager';
import type { McpStdioConfig } from '@tkottke90/tools-manager';
import {
  listMcpServersHandler,
  createMcpServerHandler,
  patchMcpServerHandler,
  deleteMcpServerHandler,
  testNewMcpServerHandler,
  testExistingMcpServerHandler,
} from './mcp-servers.handlers.js';

const MASK = '****';

describe('routes/v1/mcp-servers.handlers', () => {
  let manager: ToolsManager;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-servers-handlers-test-'));
    manager = new ToolsManager({ configDir: dir });
    await manager.boot();
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('listMcpServersHandler()', () => {
    it('returns an empty list when no servers are configured', () => {
      const result = listMcpServersHandler(manager);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
    });

    it('masks env values in the returned config', async () => {
      await manager.addMcpServer('srv', {
        command: 'node',
        args: [],
        env: { API_KEY: 'super-secret' },
      });
      const result = listMcpServersHandler(manager);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const config = result.data[0]!.config as McpStdioConfig;
        expect(config.env?.['API_KEY']).to.equal(MASK);
      }
    });

    it('leaves an empty-string env value unmasked', async () => {
      await manager.addMcpServer('srv', { command: 'node', args: [], env: { DEBUG: '' } });
      const result = listMcpServersHandler(manager);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const config = result.data[0]!.config as McpStdioConfig;
        expect(config.env?.['DEBUG']).to.equal('');
      }
    });
  });

  describe('createMcpServerHandler()', () => {
    it('creates a server and returns it with secrets masked', async () => {
      const result = await createMcpServerHandler(manager, {
        name: 'srv',
        config: { command: 'node', args: [], env: { TOKEN: 'abc' } },
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.name).to.equal('srv');
        expect((result.data.config as McpStdioConfig).env?.['TOKEN']).to.equal(MASK);
      }
      expect(manager.listMcpServers()).to.have.key('srv');
    });

    it('returns 400 when command is missing for a stdio config', async () => {
      const result = await createMcpServerHandler(manager, {
        name: 'srv',
        config: { args: [] },
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when url is missing for an http config', async () => {
      const result = await createMcpServerHandler(manager, {
        name: 'srv',
        config: { transport: 'http' },
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 409 when the name already exists', async () => {
      await manager.addMcpServer('dup', { command: 'node', args: [] });
      const result = await createMcpServerHandler(manager, {
        name: 'dup',
        config: { command: 'node', args: [] },
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });
  });

  describe('patchMcpServerHandler()', () => {
    it('returns 404 when the server does not exist', async () => {
      const result = await patchMcpServerHandler(manager, 'ghost', { enabled: false });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('applies a plain field change', async () => {
      await manager.addMcpServer('srv', { command: 'node', args: [] });
      const result = await patchMcpServerHandler(manager, 'srv', { enabled: false });
      expect(result.ok).to.equal(true);
      const stored = manager.listMcpServers()['srv'] as McpStdioConfig;
      expect(stored.enabled).to.equal(false);
    });

    it('keeps the stored secret when the incoming value is still the mask', async () => {
      await manager.addMcpServer('srv', {
        command: 'node',
        args: [],
        env: { API_KEY: 'real-secret' },
      });
      const result = await patchMcpServerHandler(manager, 'srv', {
        env: { API_KEY: MASK },
        enabled: false,
      });
      expect(result.ok).to.equal(true);
      const stored = manager.listMcpServers()['srv'] as McpStdioConfig;
      expect(stored.env?.['API_KEY']).to.equal('real-secret');
      expect(stored.enabled).to.equal(false);
    });

    it('overwrites the stored secret when a real new value is sent', async () => {
      await manager.addMcpServer('srv', {
        command: 'node',
        args: [],
        env: { API_KEY: 'old-secret' },
      });
      await patchMcpServerHandler(manager, 'srv', { env: { API_KEY: 'new-secret' } });
      const stored = manager.listMcpServers()['srv'] as McpStdioConfig;
      expect(stored.env?.['API_KEY']).to.equal('new-secret');
    });
  });

  describe('deleteMcpServerHandler()', () => {
    it('removes an existing server', async () => {
      await manager.addMcpServer('srv', { command: 'node', args: [] });
      const result = await deleteMcpServerHandler(manager, 'srv');
      expect(result.ok).to.equal(true);
      expect(manager.listMcpServers()).to.not.have.key('srv');
    });

    it('returns 404 when the server does not exist', async () => {
      const result = await deleteMcpServerHandler(manager, 'ghost');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('testNewMcpServerHandler()', () => {
    it('returns 200 with capabilities data when the probe succeeds', async () => {
      const capabilities = {
        tools: [{ name: 'a', description: 'tool a' }],
        resources: [{ uri: 'file:///x', name: 'x' }],
        resourceTemplates: [],
      };
      const result = await testNewMcpServerHandler(
        { command: 'node', args: [] },
        async () => capabilities,
      );
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal(capabilities);
    });

    it('returns 502 when the probe fails', async () => {
      const result = await testNewMcpServerHandler({ command: 'node', args: [] }, async () => {
        throw new Error('connection refused');
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(502);
        expect(result.error).to.include('connection refused');
      }
    });

    it('returns 400 for an invalid draft config', async () => {
      const result = await testNewMcpServerHandler({ args: [] }, async () => ({
        tools: [],
        resources: [],
        resourceTemplates: [],
      }));
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('testExistingMcpServerHandler()', () => {
    it('returns 404 before ever calling the test function for an unknown name', async () => {
      let called = false;
      const result = await testExistingMcpServerHandler(manager, 'ghost', {}, async () => {
        called = true;
        return { tools: [], resources: [], resourceTemplates: [] };
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
      expect(called).to.equal(false);
    });

    it('unmasks the stored secret before probing', async () => {
      await manager.addMcpServer('srv', {
        command: 'node',
        args: [],
        env: { API_KEY: 'real-secret' },
      });
      let seenValue: string | undefined;
      const result = await testExistingMcpServerHandler(
        manager,
        'srv',
        { env: { API_KEY: MASK } },
        async (config) => {
          seenValue = (config as McpStdioConfig).env?.['API_KEY'];
          return {
            tools: [{ name: 'x', description: 'tool x' }],
            resources: [],
            resourceTemplates: [],
          };
        },
      );
      expect(result.ok).to.equal(true);
      expect(seenValue).to.equal('real-secret');
    });

    it('returns 502 when the probe fails', async () => {
      await manager.addMcpServer('srv', { command: 'node', args: [] });
      const result = await testExistingMcpServerHandler(manager, 'srv', {}, async () => {
        throw new Error('timed out');
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(502);
    });
  });
});
