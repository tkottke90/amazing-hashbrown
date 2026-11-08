import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toolStub } from './tool-stub.js';

describe('agents/tools/tool-stub', () => {
  describe('toolStub()', () => {
    it('reports chars: 0 and lines: 0 for empty content [unit]', () => {
      const result = toolStub('', { tool: 'x' }, []);
      expect(result).to.include('chars: 0');
      expect(result).to.include('lines: 0');
    });

    it('reports lines: 1 for single-line content with no newline [unit]', () => {
      const result = toolStub('hello world', { tool: 'x' }, []);
      expect(result).to.include('lines: 1');
      expect(result).to.include('chars: 11');
    });

    it('reports lines: 3 for three-line content [unit]', () => {
      const result = toolStub('a\nb\nc', { tool: 'x' }, []);
      expect(result).to.include('lines: 3');
      expect(result).to.include('chars: 5');
    });

    it("derives lines from the real split('\\n') count, including a trailing newline [unit]", () => {
      // 'a\nb\n'.split('\n') === ['a', 'b', ''] — 3 elements, not 2. This
      // test documents the actual semantic rather than an assumed one.
      const result = toolStub('a\nb\n', { tool: 'x' }, []);
      expect(result).to.include('lines: 3');
    });

    it('derives chars/lines from the content argument, not from any caller-supplied value [unit]', () => {
      // A caller passing a stale/wrong chars field in frontmatter is
      // overridden by the real content length — chars/lines are never
      // trusted from the caller.
      const result = toolStub('abc', { tool: 'x', chars: 999, lines: 999 }, []);
      expect(result).to.include('chars: 3');
      expect(result).to.include('lines: 1');
    });

    it('still renders every caller-supplied frontmatter field verbatim alongside the derived ones [unit]', () => {
      const result = toolStub('abc', { tool: 'web_fetch', key: 'kv_1', threadId: 'thread-1' }, []);
      expect(result).to.include('tool: web_fetch');
      expect(result).to.include('key: kv_1');
      expect(result).to.include('threadId: thread-1');
    });

    it('still renders each section under its own header, unaffected by the signature change [unit]', () => {
      const result = toolStub('abc', { tool: 'x' }, [
        { name: 'summary', content: 'a short summary' },
      ]);
      expect(result).to.include('summary');
      expect(result).to.include('a short summary');
    });

    it('opens with the CONTENT OFFLOADED header [unit]', () => {
      const result = toolStub('abc', { tool: 'x' }, []);
      expect(result).to.match(/^── CONTENT OFFLOADED ──/);
    });
  });
});
