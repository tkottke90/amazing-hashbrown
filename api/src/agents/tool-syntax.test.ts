import { describe, it } from 'mocha';
import { expect } from 'chai';
import { extractRequestedToolIds, buildRequiredToolBlocks } from './tool-syntax.js';

describe('agents/tool-syntax', () => {
  describe('extractRequestedToolIds()', () => {
    it('returns an empty array when there is no # token', () => {
      expect(extractRequestedToolIds('just a plain message')).to.deep.equal([]);
    });

    it('extracts a single token', () => {
      expect(extractRequestedToolIds('#web_fetch summarize this')).to.deep.equal(['web_fetch']);
    });

    it('extracts multiple distinct tokens regardless of position', () => {
      expect(
        extractRequestedToolIds(
          '#duckduckgo-mcp-search Research current AI trends\n#duckduckgo-mcp-fetch_content Retrieve details',
        ),
      ).to.deep.equal(['duckduckgo-mcp-search', 'duckduckgo-mcp-fetch_content']);
    });

    it('dedupes a token mentioned more than once', () => {
      expect(extractRequestedToolIds('#web_fetch this and also #web_fetch that')).to.deep.equal([
        'web_fetch',
      ]);
    });

    it('supports the MCP slug:toolName colon form', () => {
      expect(extractRequestedToolIds('#playwright:browser_click do it')).to.deep.equal([
        'playwright:browser_click',
      ]);
    });

    it('does not consume trailing punctuation into the token', () => {
      expect(extractRequestedToolIds('please use #web_fetch.')).to.deep.equal(['web_fetch']);
    });

    it('finds a token embedded in a longer skill-expanded body', () => {
      const expanded = 'Collect the fields, then call create_workspace.\n\n#web_fetch check this first';
      expect(extractRequestedToolIds(expanded)).to.deep.equal(['web_fetch']);
    });

    it('does not match a bare # with no following identifier characters', () => {
      expect(extractRequestedToolIds('this costs # 5 dollars')).to.deep.equal([]);
    });
  });

  describe('buildRequiredToolBlocks()', () => {
    it('produces a block for a requested id that is in enabledIds', () => {
      const blocks = buildRequiredToolBlocks(['web_fetch'], new Set(['web_fetch', 'rlm_query']));
      expect(blocks).to.have.length(1);
      expect(blocks[0]).to.equal(
        '<required-tool id="web_fetch">The user has explicitly asked that you use the web_fetch tool to complete this request</required-tool>',
      );
    });

    it('drops a requested id that is not in enabledIds (typo or disabled)', () => {
      expect(buildRequiredToolBlocks(['not_a_real_tool'], new Set(['web_fetch']))).to.deep.equal(
        [],
      );
    });

    it('returns an empty array for an empty requested list', () => {
      expect(buildRequiredToolBlocks([], new Set(['web_fetch']))).to.deep.equal([]);
    });

    it('produces one block per matched id, preserving order, when several are requested', () => {
      const blocks = buildRequiredToolBlocks(
        ['web_fetch', 'rlm_query'],
        new Set(['web_fetch', 'rlm_query']),
      );
      expect(blocks).to.have.length(2);
      expect(blocks[0]).to.include('id="web_fetch"');
      expect(blocks[1]).to.include('id="rlm_query"');
    });
  });
});
