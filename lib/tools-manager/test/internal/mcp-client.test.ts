import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildMcpClient } from '../../src/internal/mcp-client.js';
import type { McpConfigFile } from '../../src/types.js';

describe('mcp-client', () => {
  describe('buildMcpClient()', () => {
    it('returns null when mcpServers is empty', () => {
      const config: McpConfigFile = { mcpServers: {} };
      expect(buildMcpClient(config)).to.equal(null);
    });

    it('returns null when every server is disabled', () => {
      const config: McpConfigFile = {
        mcpServers: {
          a: { command: 'node', args: [], enabled: false },
          b: { command: 'node', args: [], enabled: false },
        },
      };
      expect(buildMcpClient(config)).to.equal(null);
    });

    it('returns a client when at least one server is enabled', () => {
      const config: McpConfigFile = {
        mcpServers: {
          a: { command: 'node', args: [], enabled: false },
          b: { command: 'node', args: [] },
        },
      };
      expect(buildMcpClient(config)).to.not.equal(null);
    });

    it('returns a client when enabled is left unset (defaults to on)', () => {
      const config: McpConfigFile = {
        mcpServers: { a: { command: 'node', args: [] } },
      };
      expect(buildMcpClient(config)).to.not.equal(null);
    });
  });
});
