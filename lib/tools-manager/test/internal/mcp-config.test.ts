import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMcpConfig, writeMcpConfig, parseMcpSource } from '../../src/internal/mcp-config.js';
import type { McpConfigFile } from '../../src/types.js';

const VALID_CONFIG: McpConfigFile = {
  mcpServers: {
    myServer: { command: 'node', args: ['server.js'] },
  },
};

describe('mcp-config', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── parseMcpSource ────────────────────────────────────────────────────────

  describe('parseMcpSource', () => {
    it('parses a valid config from a Buffer', async () => {
      const buf = Buffer.from(JSON.stringify(VALID_CONFIG));
      const result = await parseMcpSource(buf);
      expect(result.mcpServers).to.deep.equal(VALID_CONFIG.mcpServers);
    });

    it('parses a valid config from a file path', async () => {
      const filePath = join(dir, 'source.json');
      await writeFile(filePath, JSON.stringify(VALID_CONFIG), 'utf8');
      const result = await parseMcpSource(filePath);
      expect(result.mcpServers).to.deep.equal(VALID_CONFIG.mcpServers);
    });

    it('throws when mcpServers key is missing', async () => {
      const buf = Buffer.from(JSON.stringify({ something: 'else' }));
      let threw = false;
      try {
        await parseMcpSource(buf);
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('mcpServers');
      }
      expect(threw).to.equal(true);
    });

    it('throws when mcpServers is null', async () => {
      const buf = Buffer.from(JSON.stringify({ mcpServers: null }));
      let threw = false;
      try {
        await parseMcpSource(buf);
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('throws when input is not valid JSON', async () => {
      const buf = Buffer.from('not json {{{');
      let threw = false;
      try {
        await parseMcpSource(buf);
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });

  // ── readMcpConfig ─────────────────────────────────────────────────────────

  describe('readMcpConfig', () => {
    it('returns empty config when file does not exist', async () => {
      const result = await readMcpConfig(join(dir, 'nonexistent.json'));
      expect(result).to.deep.equal({ mcpServers: {} });
    });

    it('reads a valid config file', async () => {
      const filePath = join(dir, 'read-valid.json');
      await writeFile(filePath, JSON.stringify(VALID_CONFIG), 'utf8');
      const result = await readMcpConfig(filePath);
      expect(result.mcpServers).to.deep.equal(VALID_CONFIG.mcpServers);
    });

    it('returns empty config when file contains invalid JSON', async () => {
      const filePath = join(dir, 'bad.json');
      await writeFile(filePath, 'not json', 'utf8');
      const result = await readMcpConfig(filePath);
      expect(result).to.deep.equal({ mcpServers: {} });
    });

    it('returns empty config when file is missing mcpServers key', async () => {
      const filePath = join(dir, 'no-key.json');
      await writeFile(filePath, JSON.stringify({ other: 1 }), 'utf8');
      const result = await readMcpConfig(filePath);
      expect(result).to.deep.equal({ mcpServers: {} });
    });
  });

  // ── writeMcpConfig ────────────────────────────────────────────────────────

  describe('writeMcpConfig', () => {
    it('round-trips a config', async () => {
      const filePath = join(dir, 'roundtrip.json');
      await writeMcpConfig(filePath, VALID_CONFIG);
      const result = await readMcpConfig(filePath);
      expect(result).to.deep.equal(VALID_CONFIG);
    });

    it('uses 2-space indentation', async () => {
      const filePath = join(dir, 'indent.json');
      await writeMcpConfig(filePath, VALID_CONFIG);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).to.include('  ');
      expect(JSON.stringify(JSON.parse(raw), null, 2)).to.equal(raw);
    });

    it('leaves no .tmp file after write', async () => {
      const filePath = join(dir, 'atomic.json');
      await writeMcpConfig(filePath, VALID_CONFIG);
      let tmpExists = true;
      try {
        await readFile(filePath + '.tmp');
      } catch {
        tmpExists = false;
      }
      expect(tmpExists).to.equal(false);
    });

    it('overwrites existing file', async () => {
      const filePath = join(dir, 'overwrite.json');
      await writeMcpConfig(filePath, { mcpServers: {} });
      await writeMcpConfig(filePath, VALID_CONFIG);
      const result = await readMcpConfig(filePath);
      expect(result).to.deep.equal(VALID_CONFIG);
    });
  });
});
