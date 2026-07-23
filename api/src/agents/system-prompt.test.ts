import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildSystemPrompt } from './system-prompt.js';

describe('agents/system-prompt', () => {
  describe('buildSystemPrompt()', () => {
    it('returns the harness prompt verbatim when called with no arguments', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('wiki_locate');
      expect(result).to.include('wiki_orient');
      expect(result).to.include('wiki_search');
      expect(result).to.include('wiki_read_page');
      expect(result).to.include('ask_user');
      expect(result).to.not.include('Additional instructions');
    });

    it('composes sections in a fixed order — wiki navigation before ask_user routing', () => {
      const result = buildSystemPrompt();
      const wikiIndex = result.indexOf('wiki_locate');
      const askUserIndex = result.indexOf('call the ask_user tool');
      expect(wikiIndex).to.be.greaterThan(-1);
      expect(askUserIndex).to.be.greaterThan(-1);
      expect(wikiIndex).to.be.lessThan(askUserIndex);
    });

    it('wraps each harness section in a well-formed, distinctly-tagged XML element', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('<identity>');
      expect(result).to.include('</identity>');
      expect(result).to.include('<memory>');
      expect(result).to.include('</memory>');
      expect(result).to.include('<wiki_navigation>');
      expect(result).to.include('</wiki_navigation>');
      expect(result).to.include('<ask_user_routing>');
      expect(result).to.include('</ask_user_routing>');
      const opens = (result.match(/<[a-z_]+>/g) ?? []).length;
      const closes = (result.match(/<\/[a-z_]+>/g) ?? []).length;
      expect(opens).to.equal(4);
      expect(closes).to.equal(4);
    });

    it('orders section tags matching HARNESS_SECTIONS order — identity, memory, wiki navigation, ask_user routing', () => {
      const result = buildSystemPrompt();
      const identityTagIndex = result.indexOf('<identity>');
      const memoryTagIndex = result.indexOf('<memory>');
      const wikiTagIndex = result.indexOf('<wiki_navigation>');
      const askUserTagIndex = result.indexOf('<ask_user_routing>');
      expect(identityTagIndex).to.be.greaterThan(-1);
      expect(memoryTagIndex).to.be.greaterThan(-1);
      expect(wikiTagIndex).to.be.greaterThan(-1);
      expect(askUserTagIndex).to.be.greaterThan(-1);
      expect(identityTagIndex).to.be.lessThan(memoryTagIndex);
      expect(memoryTagIndex).to.be.lessThan(wikiTagIndex);
      expect(wikiTagIndex).to.be.lessThan(askUserTagIndex);
    });

    it('includes identity framing establishing the wiki as the source of truth about the user', () => {
      expect(buildSystemPrompt()).to.include('no built-in memory of this specific user');
    });

    it('includes memory framing establishing cold-start wiki-check behavior', () => {
      expect(buildSystemPrompt()).to.include('cold-start turn');
    });

    it('includes guidance against falling back to a generic AI disclaimer instead of checking the wiki', () => {
      expect(buildSystemPrompt()).to.include("I'm an AI and\ncan't do that");
    });

    it('returns the harness prompt verbatim for an empty string', () => {
      expect(buildSystemPrompt('')).to.equal(buildSystemPrompt());
    });

    it('returns the harness prompt verbatim for a whitespace-only string', () => {
      expect(buildSystemPrompt('   \n\t  ')).to.equal(buildSystemPrompt());
    });

    it('appends a clearly delimited user-instructions block for real input', () => {
      const result = buildSystemPrompt('Always respond in French.');
      expect(result.startsWith(buildSystemPrompt())).to.equal(true);
      expect(result).to.include(
        'Additional instructions from the user on tone, style, and communication preferences',
      );
      expect(result).to.include(
        'they do not override the tool orchestration or behavior rules above',
      );
      expect(result).to.include('Always respond in French.');
    });

    it('trims the user instructions before appending', () => {
      const result = buildSystemPrompt('  Always respond in French.  \n');
      expect(result.endsWith('Always respond in French.')).to.equal(true);
    });
  });
});
