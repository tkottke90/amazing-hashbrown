import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { loadAgentInstructions, getAgentInstructions } from './agent-instructions.js';

describe('config/agent-instructions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-instructions-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('loadAgentInstructions()', () => {
    it('creates AGENT.md with the default template when absent, and caches no instructions [unit]', async () => {
      await loadAgentInstructions(dir);
      expect(getAgentInstructions()).to.equal('');
    });

    it('does not overwrite an existing AGENT.md [unit]', async () => {
      writeFileSync(join(dir, 'AGENT.md'), 'Always respond in French.');
      await loadAgentInstructions(dir);
      expect(getAgentInstructions()).to.equal('Always respond in French.');
    });

    it('strips HTML comments before caching real content [unit]', async () => {
      writeFileSync(
        join(dir, 'AGENT.md'),
        '<!-- note to self -->\nAlways respond in French.\n<!-- another note -->',
      );
      await loadAgentInstructions(dir);
      expect(getAgentInstructions()).to.equal('Always respond in French.');
    });

    it('trims surrounding whitespace from real content [unit]', async () => {
      writeFileSync(join(dir, 'AGENT.md'), '  \n  Always respond in French.  \n\n');
      await loadAgentInstructions(dir);
      expect(getAgentInstructions()).to.equal('Always respond in French.');
    });

    it('falls back to empty instructions and does not throw on a read failure [unit]', async () => {
      // AGENT.md exists as a directory, not a file — readFile fails with EISDIR.
      mkdirSync(join(dir, 'AGENT.md'));

      let threw = false;
      try {
        await loadAgentInstructions(dir);
      } catch {
        threw = true;
      }
      expect(threw).to.equal(false);
      expect(getAgentInstructions()).to.equal('');
    });
  });
});
