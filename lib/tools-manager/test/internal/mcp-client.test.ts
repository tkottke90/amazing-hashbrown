import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildMcpClient, fetchAllMcpTools } from '../../src/internal/mcp-client.js';
import type { McpConfigFile } from '../../src/types.js';

// Minimal fake matching the one shape fetchAllMcpTools actually calls
// (client.initializeConnections()) — avoids depending on real
// @langchain/mcp-adapters connection behavior for a pure isolation test.
function fakeClient(behavior: 'resolve' | 'reject', serverName: string) {
  return {
    initializeConnections:
      behavior === 'resolve'
        ? async () => ({
            [serverName]: [
              {
                name: `${serverName}-tool`,
                description: 'a tool',
                schema: {},
                invoke: async () => 'ok',
              },
            ],
          })
        : async () => {
            throw new Error(`${serverName} unreachable`);
          },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('mcp-client', () => {
  describe('buildMcpClient()', () => {
    it('returns an empty map when mcpServers is empty', () => {
      const config: McpConfigFile = { mcpServers: {} };
      expect(buildMcpClient(config).size).to.equal(0);
    });

    it('excludes disabled servers', () => {
      const config: McpConfigFile = {
        mcpServers: {
          a: { command: 'node', args: [], enabled: false },
          b: { command: 'node', args: [], enabled: false },
        },
      };
      expect(buildMcpClient(config).size).to.equal(0);
    });

    it('returns one client per enabled server', () => {
      const config: McpConfigFile = {
        mcpServers: {
          a: { command: 'node', args: [], enabled: false },
          b: { command: 'node', args: [] },
          c: { command: 'node', args: [] },
        },
      };
      const clients = buildMcpClient(config);
      expect(clients.size).to.equal(2);
      expect(clients.has('b')).to.equal(true);
      expect(clients.has('c')).to.equal(true);
      expect(clients.has('a')).to.equal(false);
    });

    it('includes a server when enabled is left unset (defaults to on)', () => {
      const config: McpConfigFile = {
        mcpServers: { a: { command: 'node', args: [] } },
      };
      expect(buildMcpClient(config).has('a')).to.equal(true);
    });
  });

  describe('fetchAllMcpTools()', () => {
    it('returns tools and connected status for a healthy server', async () => {
      const clients = new Map([['healthy', fakeClient('resolve', 'healthy')]]);
      const { tools, statuses } = await fetchAllMcpTools(clients);
      expect(tools.map((t) => t.name)).to.deep.equal(['healthy-tool']);
      expect(statuses.get('healthy')).to.equal('connected');
    });

    it('isolates a failing server: does not throw, contributes no tools, marked unreachable', async () => {
      const clients = new Map([['broken', fakeClient('reject', 'broken')]]);
      const { tools, statuses } = await fetchAllMcpTools(clients);
      expect(tools).to.have.length(0);
      expect(statuses.get('broken')).to.equal('unreachable');
    });

    it('one failing server does not block another healthy server in the same call', async () => {
      const clients = new Map([
        ['broken', fakeClient('reject', 'broken')],
        ['healthy', fakeClient('resolve', 'healthy')],
      ]);
      const { tools, statuses } = await fetchAllMcpTools(clients);
      expect(tools.map((t) => t.name)).to.deep.equal(['healthy-tool']);
      expect(statuses.get('broken')).to.equal('unreachable');
      expect(statuses.get('healthy')).to.equal('connected');
    });
  });
});
