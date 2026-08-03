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
      expect(result).to.include('<web_fetch>');
      expect(result).to.include('</web_fetch>');
      expect(result).to.include('<ask_user_routing>');
      expect(result).to.include('</ask_user_routing>');
      const opens = (result.match(/<[a-z_]+>/g) ?? []).length;
      const closes = (result.match(/<\/[a-z_]+>/g) ?? []).length;
      expect(opens).to.equal(5);
      expect(closes).to.equal(5);
    });

    it('orders section tags matching HARNESS_SECTIONS order — identity, memory, wiki navigation, web fetch, ask_user routing', () => {
      const result = buildSystemPrompt();
      const identityTagIndex = result.indexOf('<identity>');
      const memoryTagIndex = result.indexOf('<memory>');
      const wikiTagIndex = result.indexOf('<wiki_navigation>');
      const webFetchTagIndex = result.indexOf('<web_fetch>');
      const askUserTagIndex = result.indexOf('<ask_user_routing>');
      expect(identityTagIndex).to.be.greaterThan(-1);
      expect(memoryTagIndex).to.be.greaterThan(-1);
      expect(wikiTagIndex).to.be.greaterThan(-1);
      expect(webFetchTagIndex).to.be.greaterThan(-1);
      expect(askUserTagIndex).to.be.greaterThan(-1);
      expect(identityTagIndex).to.be.lessThan(memoryTagIndex);
      expect(memoryTagIndex).to.be.lessThan(wikiTagIndex);
      expect(wikiTagIndex).to.be.lessThan(webFetchTagIndex);
      expect(webFetchTagIndex).to.be.lessThan(askUserTagIndex);
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

    it('generalizes the cold-start wiki-check rule to stored how-tos, not just preferences/facts/history', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'This applies just as much to a stored how-to as to a stored personal fact',
      );
      expect(result).to.include(
        "Don't reason your way out of checking just because the topic sounds like something you",
      );
    });

    it("gives a tool's own result priority over the default step-skipping guidance", () => {
      const result = buildSystemPrompt();
      expect(result).to.include("A tool's own result is more current than this default guidance");
      expect(result).to.include('follow that over\nwhatever step you would otherwise skip');
    });

    it('narrows "obvious" to an established domain or no plausible alternative, not a subjective guess', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('no other domain could plausibly cover it');
      expect(result).to.include(
        'A topic merely sounding personal or plausible is not the same as an established domain',
      );
    });

    it('anchors the obvious-vs-ambiguous rule with a worked contrastive example', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('"What\'s my favorite color?" has no plausible domain other than');
      expect(result).to.include('"What have you noticed about growth lately?" could mean');
    });

    it('distinguishes a concrete personal-fact question from a meta-question about which domain to check', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'That skip only covers a direct question about a concrete personal fact — not a question about where to',
      );
      expect(result).to.include(
        '"Which part of the knowledge base should I check for my personal preferences?" is asking for domain',
      );
    });

    it("doesn't extend the skip-to-search permission to a technical or setup-specific topic", () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        "A technical or setup-specific topic isn't an outright match for the user's own domain either",
      );
      expect(result).to.include(
        '"What was the process for generating a new NPM token for Verdaccio?" could\nbelong to a dedicated technical domain',
      );
    });

    it('covers possessive phrasing of the same technical topic, not just the bare noun phrase', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        '"I need to generate a new NPM token for my Verdaccio\ninstance" names the same ambiguous technical topic as before',
      );
      expect(result).to.include(
        "doesn't turn a technical topic into an outright single-domain match either",
      );
    });

    it('restricts the skip-straight-to-search permission to an outright single-domain match', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('wiki_search always searches across every domain at once');
      expect(result).to.include('wiki_orient\non that domain is what actually confines you to it');
    });

    it('gives a concrete, countable test for multi-candidate vs. single-match, independent of self-resolution', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        "if wiki_locate's result named more than one domain, that's the\nmulti-candidate case, even after you've worked out which one actually applies",
      );
      expect(result).to.include(
        "Figuring out the right answer yourself doesn't\nturn a multi-candidate result into a single-match one.",
      );
    });

    it('requires narrowing an ambiguous locate match with real information, not a fabricated guess', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'only narrow it yourself with information the user actually already gave you',
      );
      expect(result).to.include("Don't invent a more specific context to retry wiki_locate with");
    });

    it("doesn't let the model's own plausibility hunch override a reported tie", () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'A reported tie is a tie even if one candidate feels more plausible to you',
      );
      expect(result).to.include(
        'the only correct move is\nto call ask_user, not to decide for them',
      );
    });

    it('orders URL ingestion fetch-first — web_fetch before any wiki tool', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('call web_fetch first, before any\nwiki tool');
      expect(result).to.include('Fetch, then route,\nthen write.');
    });

    it('treats "save what you fetched" as an already-made decision with a direct write path', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'the user asks you to save what it returned, that request is the decision',
      );
      expect(result).to.include('call wiki_create_page\ndirectly with the fetched content');
      expect(result).to.include(
        'is the confirmation round-trip ask_user_routing tells you not to make',
      );
    });

    it('treats an explicit "check X"/"fix X" request as already-made — no confirmation round-trip', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('that instruction is the decision, already made');
      expect(result).to.include('run the check or apply the fix, then report\nwhat happened');
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
