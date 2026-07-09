import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { ToolsManager } from '../src/tools-manager.js';
import type { RegisteredTool, McpStdioConfig } from '../src/types.js';

function makeBuiltin(name: string): RegisteredTool {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({ input: z.string() }),
    source: 'builtin',
    execute: async (args) => ({ result: args['input'] }),
  };
}

// Bypass real MCP connections — set this seam before calling getTools/execute
function bypassMcp(manager: ToolsManager): void {
  (manager as unknown as Record<string, unknown>)['_ensureMcpInitialized'] = async () => {};
  // Prevent _resetMcpClient from trying to close a real client
  (manager as unknown as Record<string, unknown>)['mcpClient'] = null;
}

describe('ToolsManager', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tools-manager-test-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── boot() ───────────────────────────────────────────────────────────────

  describe('boot()', () => {
    it('creates configDir if it does not exist', async () => {
      const configDir = join(dir, 'new-config-dir');
      const manager = new ToolsManager({ configDir });
      await manager.boot();
      // If mkdir failed this would throw
      const stat = await import('node:fs/promises').then((m) => m.stat(configDir));
      expect(stat.isDirectory()).to.equal(true);
      await manager.close();
    });

    it('creates mcp.json if it does not exist', async () => {
      const configDir = join(dir, 'boot-creates-mcp');
      const manager = new ToolsManager({ configDir });
      await manager.boot();
      const raw = await readFile(join(configDir, 'mcp.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).to.deep.equal({ mcpServers: {} });
      await manager.close();
    });

    it('loads existing mcp.json on second boot', async () => {
      const configDir = join(dir, 'boot-loads-existing');
      const serverConfig: McpStdioConfig = { command: 'node', args: ['srv.js'] };

      const manager1 = new ToolsManager({ configDir });
      await manager1.boot();
      bypassMcp(manager1);
      await manager1.addMcpServer('existing', serverConfig);
      await manager1.close();

      const manager2 = new ToolsManager({ configDir });
      await manager2.boot();
      const servers = manager2.listMcpServers();
      expect(servers).to.have.key('existing');
      await manager2.close();
    });
  });

  // ── register() + list() ───────────────────────────────────────────────────

  describe('register() and list()', () => {
    let manager: ToolsManager;

    beforeEach(async () => {
      manager = new ToolsManager({ configDir: join(dir, `reg-${Math.random()}`) });
      await manager.boot();
      bypassMcp(manager);
    });

    afterEach(async () => {
      await manager.close();
    });

    it('registers a builtin and list() returns it', () => {
      const tool = makeBuiltin('my-tool');
      manager.register(tool);
      const all = manager.list();
      expect(all).to.have.length(1);
      expect(all[0]!.name).to.equal('my-tool');
    });

    it('list() returns all registered builtins', () => {
      manager.register(makeBuiltin('a'));
      manager.register(makeBuiltin('b'));
      const names = manager.list().map((t) => t.name);
      expect(names).to.include('a').and.include('b');
    });
  });

  // ── getTools() ────────────────────────────────────────────────────────────

  describe('getTools()', () => {
    let manager: ToolsManager;

    beforeEach(async () => {
      manager = new ToolsManager({ configDir: join(dir, `gt-${Math.random()}`) });
      await manager.boot();
      bypassMcp(manager);
    });

    afterEach(async () => {
      await manager.close();
    });

    it('returns ToolDefinition[] (no execute property)', async () => {
      manager.register(makeBuiltin('t1'));
      const tools = await manager.getTools();
      expect(tools).to.have.length(1);
      const t = tools[0]!;
      expect(t).to.have.keys(['name', 'description', 'parameters']);
      expect(t).to.not.have.property('execute');
    });

    it('returns all tools when no filter is given', async () => {
      manager.register(makeBuiltin('a'));
      manager.register(makeBuiltin('b'));
      const tools = await manager.getTools();
      expect(tools.map((t) => t.name)).to.include.members(['a', 'b']);
    });

    it('filters to only matching tools', async () => {
      manager.register(makeBuiltin('alpha'));
      manager.register(makeBuiltin('beta'));
      manager.register(makeBuiltin('gamma'));
      const tools = await manager.getTools(['alpha', 'gamma']);
      expect(tools.map((t) => t.name)).to.deep.equal(['alpha', 'gamma']);
    });

    it('returns empty array when filter matches nothing', async () => {
      manager.register(makeBuiltin('alpha'));
      const tools = await manager.getTools(['nonexistent']);
      expect(tools).to.have.length(0);
    });

    it('returns all tools when filter is empty array', async () => {
      manager.register(makeBuiltin('a'));
      const tools = await manager.getTools([]);
      expect(tools).to.have.length(1);
    });
  });

  // ── execute() ────────────────────────────────────────────────────────────

  describe('execute()', () => {
    let manager: ToolsManager;

    beforeEach(async () => {
      manager = new ToolsManager({ configDir: join(dir, `ex-${Math.random()}`) });
      await manager.boot();
      bypassMcp(manager);
    });

    afterEach(async () => {
      await manager.close();
    });

    it('dispatches to the matching builtin execute handler', async () => {
      manager.register(makeBuiltin('echo'));
      const result = await manager.execute({ name: 'echo', arguments: { input: 'hello' } });
      expect(result).to.deep.equal({ result: 'hello' });
    });

    it('throws for an unknown tool name', async () => {
      let threw = false;
      try {
        await manager.execute({ name: 'missing', arguments: {} });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('missing');
      }
      expect(threw).to.equal(true);
    });
  });

  // ── MCP server CRUD ───────────────────────────────────────────────────────

  describe('MCP server CRUD', () => {
    let manager: ToolsManager;
    let configDir: string;

    beforeEach(async () => {
      configDir = join(dir, `mcp-${Math.random()}`);
      manager = new ToolsManager({ configDir });
      await manager.boot();
      bypassMcp(manager);
    });

    afterEach(async () => {
      await manager.close();
    });

    describe('importMcpConfig()', () => {
      it('replaces mcpServers from a Buffer', async () => {
        const config = { mcpServers: { imported: { command: 'node', args: [] } } };
        await manager.importMcpConfig(Buffer.from(JSON.stringify(config)));
        const servers = manager.listMcpServers();
        expect(servers).to.have.key('imported');
      });

      it('persists to mcp.json', async () => {
        const config = { mcpServers: { fromBuf: { command: 'node', args: [] } } };
        await manager.importMcpConfig(Buffer.from(JSON.stringify(config)));
        const raw = await readFile(join(configDir, 'mcp.json'), 'utf8');
        expect(JSON.parse(raw).mcpServers).to.have.key('fromBuf');
      });

      it('replaces (not merges) existing servers', async () => {
        await manager.addMcpServer('old', { command: 'old', args: [] });
        const newConfig = { mcpServers: { fresh: { command: 'fresh', args: [] } } };
        await manager.importMcpConfig(Buffer.from(JSON.stringify(newConfig)));
        const servers = manager.listMcpServers();
        expect(servers).to.not.have.key('old');
        expect(servers).to.have.key('fresh');
      });
    });

    describe('addMcpServer()', () => {
      it('adds a server to the in-memory config', async () => {
        await manager.addMcpServer('srv1', { command: 'node', args: ['a.js'] });
        expect(manager.listMcpServers()).to.have.key('srv1');
      });

      it('persists to mcp.json', async () => {
        await manager.addMcpServer('persisted', { command: 'node', args: [] });
        const raw = await readFile(join(configDir, 'mcp.json'), 'utf8');
        expect(JSON.parse(raw).mcpServers).to.have.key('persisted');
      });

      it('throws if the server name already exists', async () => {
        await manager.addMcpServer('dup', { command: 'node', args: [] });
        let threw = false;
        try {
          await manager.addMcpServer('dup', { command: 'other', args: [] });
        } catch (err) {
          threw = true;
          expect((err as Error).message).to.include('dup');
        }
        expect(threw).to.equal(true);
      });
    });

    describe('editMcpServer()', () => {
      it('updates fields on an existing server', async () => {
        await manager.addMcpServer('editable', { command: 'old-cmd', args: [] });
        await manager.editMcpServer('editable', { command: 'new-cmd' });
        const servers = manager.listMcpServers();
        expect((servers['editable'] as McpStdioConfig).command).to.equal('new-cmd');
      });

      it('throws when the server does not exist', async () => {
        let threw = false;
        try {
          await manager.editMcpServer('ghost', { command: 'x' });
        } catch (err) {
          threw = true;
          expect((err as Error).message).to.include('ghost');
        }
        expect(threw).to.equal(true);
      });
    });

    describe('removeMcpServer()', () => {
      it('removes an existing server', async () => {
        await manager.addMcpServer('toRemove', { command: 'node', args: [] });
        await manager.removeMcpServer('toRemove');
        expect(manager.listMcpServers()).to.not.have.key('toRemove');
      });

      it('persists the removal to mcp.json', async () => {
        await manager.addMcpServer('gone', { command: 'node', args: [] });
        await manager.removeMcpServer('gone');
        const raw = await readFile(join(configDir, 'mcp.json'), 'utf8');
        expect(JSON.parse(raw).mcpServers).to.not.have.key('gone');
      });

      it('throws when the server does not exist', async () => {
        let threw = false;
        try {
          await manager.removeMcpServer('nope');
        } catch (err) {
          threw = true;
          expect((err as Error).message).to.include('nope');
        }
        expect(threw).to.equal(true);
      });
    });

    describe('listMcpServers()', () => {
      it('returns a shallow copy (not the internal reference)', async () => {
        await manager.addMcpServer('snap', { command: 'node', args: [] });
        const snapshot = manager.listMcpServers();
        delete (snapshot as Record<string, unknown>)['snap'];
        expect(manager.listMcpServers()).to.have.key('snap');
      });
    });
  });
});
