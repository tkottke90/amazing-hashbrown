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
      expect(result).to.include('<rlm>');
      expect(result).to.include('</rlm>');
      expect(result).to.include('<ask_user_routing>');
      expect(result).to.include('</ask_user_routing>');
      const opens = (result.match(/<[a-z_]+>/g) ?? []).length;
      const closes = (result.match(/<\/[a-z_]+>/g) ?? []).length;
      expect(opens).to.equal(6);
      expect(closes).to.equal(6);
    });

    it('orders section tags matching HARNESS_SECTIONS order — identity, memory, wiki navigation, web fetch, rlm, ask_user routing', () => {
      const result = buildSystemPrompt();
      const identityTagIndex = result.indexOf('<identity>');
      const memoryTagIndex = result.indexOf('<memory>');
      const wikiTagIndex = result.indexOf('<wiki_navigation>');
      const webFetchTagIndex = result.indexOf('<web_fetch>');
      const rlmTagIndex = result.indexOf('<rlm>');
      const askUserTagIndex = result.indexOf('<ask_user_routing>');
      expect(identityTagIndex).to.be.greaterThan(-1);
      expect(memoryTagIndex).to.be.greaterThan(-1);
      expect(wikiTagIndex).to.be.greaterThan(-1);
      expect(webFetchTagIndex).to.be.greaterThan(-1);
      expect(rlmTagIndex).to.be.greaterThan(-1);
      expect(askUserTagIndex).to.be.greaterThan(-1);
      expect(identityTagIndex).to.be.lessThan(memoryTagIndex);
      expect(memoryTagIndex).to.be.lessThan(wikiTagIndex);
      expect(wikiTagIndex).to.be.lessThan(webFetchTagIndex);
      expect(webFetchTagIndex).to.be.lessThan(rlmTagIndex);
      expect(rlmTagIndex).to.be.lessThan(askUserTagIndex);
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

    it('scopes the single-match skip to concrete queries — overview questions take wiki_orient', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'The single-match skip also assumes you have something concrete to search for.',
      );
      expect(result).to.include(
        'Skipping to wiki_search to\n"see what pages exist" answers a different question than the one the user asked.',
      );
    });

    it('extends the direct-write rule to plain add-a-fact requests — create directly, no duplicate-check search', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('call wiki_create_page directly, picking\na sensible title yourself');
      expect(result).to.include(
        "Don't run a wiki_search first just to check whether a page already\nexists",
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

    it('rules out wiki_orient as a placement step before a fetched-content write', () => {
      const result = buildSystemPrompt();
      expect(result).to.include("Placement isn't a reason to orient first either");
      expect(result).to.include(
        'orienting "to find the right spot" for a\npage you\'re about to create adds a round-trip for nothing',
      );
    });

    // Rewritten after the RLM section's third tightening (ADR-001): the
    // truncate: false re-read workflow no longer exists — a truncated wiki
    // page is now a structure problem, and rlm_query is prohibited on wiki
    // pages outright. The prior assertions quoted the removed workflow and
    // went stale unnoticed; fixed as part of auto-eval 2026-08-04 round 1.
    it('prohibits rlm_query on wiki pages — truncation is a structure problem, not retrieval', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('Do not use rlm_query for wiki pages.');
      expect(result).to.include('it is a structure problem, not a retrieval one.');
    });

    it('rules out wiki_search as a within-page search substitute', () => {
      expect(buildSystemPrompt()).to.include(
        "it matches pages across every domain and cannot search\nwithin one page's text",
      );
    });

    it('names the spotted-answer temptation — no answering from your own scan of a large corpus', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('Spotting what looks like the answer partway');
      expect(result).to.include(
        'a targeted extraction over the full corpus is more reliable than answering\nfrom one visible stretch you happened to notice',
      );
    });

    it('keys the web_fetch rlm trigger on length itself, since web_fetch never truncates', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('web_fetch never truncates');
      expect(result).to.include('so length is the signal');
    });

    it('anchors the rlm rule with a small-page contrast — no rlm_query on a short, complete page', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('is yours to answer from directly');
      expect(result).to.include('adds a round-trip for nothing');
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
