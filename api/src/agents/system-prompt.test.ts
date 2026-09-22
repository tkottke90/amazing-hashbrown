import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildSystemPrompt, filterHarnessSections } from './system-prompt.js';

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
      expect(result).to.include('<notation>');
      expect(result).to.include('</notation>');
      expect(result).to.include('<wiki_navigation>');
      expect(result).to.include('</wiki_navigation>');
      expect(result).to.include('<web_fetch>');
      expect(result).to.include('</web_fetch>');
      expect(result).to.include('<wiki_ingest>');
      expect(result).to.include('</wiki_ingest>');
      expect(result).to.include('<rlm>');
      expect(result).to.include('</rlm>');
      expect(result).to.include('<shell_execution>');
      expect(result).to.include('</shell_execution>');
      expect(result).to.include('<image>');
      expect(result).to.include('</image>');
      expect(result).to.include('<ask_user_routing>');
      expect(result).to.include('</ask_user_routing>');
      const opens = (result.match(/<[a-z_]+>/g) ?? []).length;
      const closes = (result.match(/<\/[a-z_]+>/g) ?? []).length;
      expect(opens).to.equal(10);
      expect(closes).to.equal(10);
    });

    it('orders section tags matching HARNESS_SECTIONS order — identity, memory, notation, wiki navigation, web fetch, wiki ingest, rlm, shell execution, image, ask_user routing', () => {
      const result = buildSystemPrompt();
      const identityTagIndex = result.indexOf('<identity>');
      const memoryTagIndex = result.indexOf('<memory>');
      const notationTagIndex = result.indexOf('<notation>');
      const wikiTagIndex = result.indexOf('<wiki_navigation>');
      const webFetchTagIndex = result.indexOf('<web_fetch>');
      const wikiIngestTagIndex = result.indexOf('<wiki_ingest>');
      const rlmTagIndex = result.indexOf('<rlm>');
      const shellTagIndex = result.indexOf('<shell_execution>');
      const imageTagIndex = result.indexOf('<image>');
      const askUserTagIndex = result.indexOf('<ask_user_routing>');
      expect(identityTagIndex).to.be.greaterThan(-1);
      expect(memoryTagIndex).to.be.greaterThan(-1);
      expect(notationTagIndex).to.be.greaterThan(-1);
      expect(wikiTagIndex).to.be.greaterThan(-1);
      expect(webFetchTagIndex).to.be.greaterThan(-1);
      expect(wikiIngestTagIndex).to.be.greaterThan(-1);
      expect(rlmTagIndex).to.be.greaterThan(-1);
      expect(shellTagIndex).to.be.greaterThan(-1);
      expect(imageTagIndex).to.be.greaterThan(-1);
      expect(askUserTagIndex).to.be.greaterThan(-1);
      expect(identityTagIndex).to.be.lessThan(memoryTagIndex);
      expect(memoryTagIndex).to.be.lessThan(notationTagIndex);
      expect(notationTagIndex).to.be.lessThan(wikiTagIndex);
      expect(wikiTagIndex).to.be.lessThan(webFetchTagIndex);
      expect(webFetchTagIndex).to.be.lessThan(wikiIngestTagIndex);
      expect(wikiIngestTagIndex).to.be.lessThan(rlmTagIndex);
      expect(rlmTagIndex).to.be.lessThan(shellTagIndex);
      expect(shellTagIndex).to.be.lessThan(imageTagIndex);
      expect(imageTagIndex).to.be.lessThan(askUserTagIndex);
    });

    it('includes notation guidance explaining / for skills and # for required tools', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('/skill-name');
      expect(result).to.include('#tool-name');
      expect(result).to.include('required-tool');
    });

    it('anchors the unmatched #token case to the same no-directive procedure with a worked example', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'That means actually re-running\n' +
          'the same tool-selection procedure (see wiki_navigation) the request would get without any `#` text at\n' +
          'all, not treating the unmatched name as a shortcut to whichever tool sounds related. For example,\n' +
          '"#not_a_real_tool What is my favorite programming language?" resolves exactly like the bare question\n' +
          '"What is my favorite programming language?" would on its own — wiki_locate first, per wiki_navigation\'s\n' +
          'own no-directive default — not a direct wiki_search just because a tool-shaped token appeared in the\n' +
          'message.',
      );
    });

    it('includes identity framing establishing the wiki as the source of truth about the user', () => {
      expect(buildSystemPrompt()).to.include('no built-in memory of this specific user');
    });

    it('includes memory framing establishing cold-start wiki-check behavior', () => {
      expect(buildSystemPrompt()).to.include('cold-start turn');
    });

    it('gates the cold-start wiki_locate default on the absence of a required-tool directive', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'Reach for wiki_locate before responding, unless a\n' +
          '`<required-tool>` instruction (see notation) already named a different tool to call this turn — that\n' +
          'directive is the decision, not a secondary consideration to weigh against this default.',
      );
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
      expect(result).to.include("A tool's own result is more current than this guidance");
      expect(result).to.include("wins over\n     whatever step you'd otherwise skip");
    });

    it('distinguishes an unrecognized wikiId from a forbidden one that already names the correct wiki', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('an unrecognized wikiId telling you to call wiki_locate');
      expect(result).to.include(
        'is a different case from an unrecognized wikiId: the domain is\n     already known, just not the one you used',
      );
    });

    it('retries a rejected write directly with the corrected wikiId once the user confirms', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'retry the exact same call with only\n     wikiId swapped to the one the rejection named',
      );
      expect(result).to.include(
        "Don't re-derive the path, content,\n     fromPage/toPage, or rawFilePath you already had",
      );
      expect(result).to.include(
        "don't ask what they'd like to do next;\n     the confirmation already answered that",
      );
    });

    it('narrows "obvious" to an established domain or no plausible alternative, not a subjective guess', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('no other\n     domain could plausibly cover it');
      expect(result).to.include(
        'a topic that merely sounds personal or plausible without being\n     domain-exclusive',
      );
    });

    it('anchors the obvious-vs-ambiguous rule with a worked contrastive example, grouped into separate skip/no-skip example lists', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'Examples — skip wiki_locate (no other domain could plausibly cover it):',
      );
      expect(result).to.include(
        '"What\'s my favorite color?" → wiki_search directly (nothing but the user\'s own preferences\n     could ever answer this)',
      );
      expect(result).to.include(
        "Examples — call wiki_locate (looks similar, but isn't actually domain-exclusive):",
      );
      expect(result).to.include(
        '"What have you noticed about growth lately?" → wiki_locate (could be the user\'s growth or\n     your own reflective growth',
      );
    });

    it('distinguishes "favorite programming language" from "favorite color" as not domain-exclusive', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        '"What is my favorite programming language?" → wiki_locate (could belong to a\n' +
          '     technical/engineering domain instead of personal preferences — not domain-exclusive the way\n' +
          '     color is, same ambiguity as the Verdaccio example below)',
      );
    });

    it('scopes the favorite-programming-language example to the no-directive default, with a directive-present contrastive pair', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'This is the no-directive default:\n' +
          '     "#wiki_search What is my favorite programming language?" → wiki_search directly instead —\n' +
          "     the required-tool gate above already decided it, so this ambiguity doesn't apply.",
      );
    });

    it('gates the entire domain-routing procedure on the absence of a required-tool directive, checked first', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'A `<required-tool>` instruction already resolved which tool to use this turn (see notation) —\n' +
          'call it directly with whatever arguments the request implies, skipping every step below.',
      );
      expect(result).to.include(
        "a topic that would otherwise call for\nwiki_locate doesn't override a directive that already answered the question",
      );
    });

    it('closes the wikiId-first loophole for a required wiki_search with no domain already known', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'This includes a\nrequired wiki_search with no domain already known: wikiId is optional and wiki_search already\n' +
          "searches across every domain when it's omitted, so call it without one rather than calling\n" +
          'wiki_locate first to produce a wikiId the directive never asked for.',
      );
    });

    it('distinguishes a concrete personal-fact question from a meta-question about which domain to check', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        "Sounding personal doesn't exempt this — a question about\n     routing is not a question about the fact itself",
      );
      expect(result).to.include(
        '"Which part of the knowledge base should I check for my personal preferences?" → wiki_locate\n     (asking for routing outright',
      );
    });

    it("doesn't extend the skip-to-search permission to a technical or setup-specific topic", () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'a technical/setup topic even phrased possessively ("my X") — call\n     wiki_locate.',
      );
      expect(result).to.include(
        '"What was the process for generating a new NPM token for Verdaccio?" and "I need to generate\n     a new NPM token for my Verdaccio instance" → wiki_locate either way (a technical/setup topic\n     could belong to a dedicated technical domain',
      );
    });

    it('covers possessive phrasing of the same technical topic, not just the bare noun phrase', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        '"I need to generate\n     a new NPM token for my Verdaccio instance" → wiki_locate either way',
      );
      expect(result).to.include(
        "the possessive\n     phrasing in the second one doesn't change that)",
      );
    });

    it('tells the agent to pass a resolved wikiId straight into wiki_search regardless of how the domain was resolved', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'directly, whether wikiId came from an outright match or from narrowing a tie',
      );
      expect(result).to.include(
        'Omit wikiId only when you deliberately want to search\n     across every domain at once',
      );
    });

    it('gives a worked example of going straight to scoped wiki_search instead of wiki_orient first', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        "Don't detour\n     through wiki_orient first: only wikiId confines the search",
      );
      expect(result).to.include(
        "orient adds nothing a direct\n     scoped search doesn't already give you",
      );
    });

    it('scopes the single-match skip to concrete queries — overview questions take wiki_orient', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'wiki_orient({ wikiId }), even on a single outright match — an overview needs the\n     page index, which only wiki_orient returns',
      );
      expect(result).to.include(
        '"What do we already know here?" → wiki_orient({ wikiId }), even on a single outright match',
      );
    });

    it('extends the direct-write rule to plain add-a-fact requests — create directly, no duplicate-check search', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'wiki_create_page directly, picking a sensible\n     title yourself',
      );
      expect(result).to.include(
        "Don't run a wiki_search first to check whether a page already exists —\n     wiki_create_page detects near-duplicates itself",
      );
    });

    it('requires narrowing an ambiguous locate match with real information, not a fabricated guess', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'Narrow to one only using\n     something real: the routing notes attributing the request to a single candidate, or something\n     the user actually said elsewhere in the conversation',
      );
      expect(result).to.include("Don't invent a narrower context to retry\n     wiki_locate with");
    });

    it("doesn't let the model's own plausibility hunch override a reported tie, leading with that claim rather than burying it", () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'a tie stays a tie even when one candidate feels more plausible\n     to you; that feeling is not real information, and proceeding on it — or announcing your pick\n     in your reply — is the same mistake as inventing a narrower context',
      );
      expect(result).to.include(
        "call ask_user and ask which domain they\n     mean — that's the only correct move, not deciding for them",
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
        'is the confirmation round-trip ask_user_routing tells\nyou not to make',
      );
    });

    it('shows the inline corpus.raw shape for a direct-write, non-stub fetch', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('corpus: { raw: "<the fetched page text, as markdown>" }');
      expect(result).to.include(
        'corpus.raw takes the content itself, as a string — not a threadId/toolKey pair',
      );
    });

    it('rules out wiki_orient as a placement step before a fetched-content write', () => {
      const result = buildSystemPrompt();
      expect(result).to.include("Placement isn't a reason to orient first either");
      expect(result).to.include(
        'orienting "to find the right spot" for a\npage you\'re about to create adds a round-trip for nothing',
      );
      expect(result).to.include(
        'the very next call is wiki_create_page — not a\nwiki_orient pass to "see the domain\'s structure" first',
      );
      expect(result).to.include(
        "not an error or a\ncorrection, so it doesn't override this direct-write path",
      );
    });

    // Issue #154: the ingest-stub instructions themselves (wiki_ingest,
    // requiring wiki_create_page) are now structurally omitted from the
    // prompt when wiki_create_page isn't bound — see filterHarnessSections()
    // tests below — rather than described-then-caveated with a workaround
    // sentence. This test now covers the fallback that stays in web_fetch
    // (requiring only web_fetch), which doesn't know whether wiki_ingest is
    // present and so never names wiki_create_page or the ingest workflow.
    it('gives web_fetch a wiki-write-agnostic fallback for a stub pointing at an ingest workflow', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'If a stub\'s summary points at a "to ingest into wiki:" workflow but you don\'t have wiki write access',
      );
      expect(result).to.include('not by asking the user for missing details like a title');
      expect(result).to.include(
        "say plainly that you don't currently have write access to store it.",
      );
    });

    it("treats an ingest block's placeholder title as the model's own naming job, not a reason to resolve get_tool_key first", () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        "The block's own title field is usually a placeholder — <page title> — for you to fill in, not a\nvalue already decided.",
      );
      expect(result).to.include('needing a title is never a reason to call get_tool_key first');
    });

    it('rules out inferring an ingest block from a stub that never had one', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        'A stub without that literal "to ingest into wiki:" heading never carries the instruction above',
      );
      expect(result).to.include(
        'is a\nget_tool_key case, not a reason to invent an ingest block that was never actually there.',
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

    it('names shell_exec as real local-system access, overriding the wiki-only framing', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('your real, working access to the local machine');
      expect(result).to.include(
        'The wiki-as-memory\nrules above are about knowledge of the user; they do not make you wiki-only.',
      );
    });

    it('anchors the no-refusal rule with the se-005 contrastive example', () => {
      const result = buildSystemPrompt();
      expect(result).to.include(
        '"I want to know the contents of /tmp/notes.txt" means run a\nread-only command like cat /tmp/notes.txt',
      );
      expect(result).to.include('not a refusal, and not a\nwiki lookup');
    });

    it('requires the reason field and prefers smallest-footprint commands', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('Always fill in the reason field');
      expect(result).to.include(
        'read with cat/head/tail rather than anything that modifies, moves, or\ndeletes',
      );
    });

    it('requires honest reporting of denied or blocked shell commands', () => {
      const result = buildSystemPrompt();
      expect(result).to.include('never present a blocked command as\nhaving succeeded');
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

    it('appends a workspace_context block distinct from the tone/style user-instructions framing', () => {
      const result = buildSystemPrompt(undefined, 'Workspace goal: ship the release.');
      expect(result.startsWith(buildSystemPrompt())).to.equal(true);
      expect(result).to.include('<workspace_context>');
      expect(result).to.include('</workspace_context>');
      expect(result).to.include('Workspace goal: ship the release.');
      // The workspace context block must not be wrapped in the tone/style
      // framing reserved for userInstructions — it's factual/operational
      // context meant to shape what the agent does, not just how it talks.
      expect(result).to.not.include('Additional instructions from the user on tone, style');
    });

    it('includes both the workspace context block and the user-instructions block when both are given', () => {
      const result = buildSystemPrompt('Always respond in French.', 'Workspace goal: ship it.');
      expect(result).to.include('<workspace_context>');
      expect(result).to.include('Workspace goal: ship it.');
      expect(result).to.include(
        'Additional instructions from the user on tone, style, and communication preferences',
      );
      expect(result).to.include('Always respond in French.');
    });

    it('omits the workspace_context block when workspaceContext is empty/whitespace', () => {
      const result = buildSystemPrompt(undefined, '   \n  ');
      expect(result).to.equal(buildSystemPrompt());
    });
  });

  // Issue #154: gates tool-scoped sections on tool binding. buildSystemPrompt()
  // itself stays unfiltered (verified above) — filterHarnessSections() is the
  // separate, explicit step production (tool-access.middleware.ts) and the
  // eval harness (bin/eval.ts via lib/evaluations' RunConfig callback) apply
  // on top, each with the tool set it already resolved for that call/scenario.
  describe('filterHarnessSections()', () => {
    const ALL_TOOL_IDS = new Set([
      'wiki_search',
      'wiki_read_page',
      'wiki_locate',
      'wiki_orient',
      'wiki_lint',
      'wiki_register_domain',
      'wiki_create_page',
      'wiki_update_page',
      'wiki_add_cross_link',
      'wiki_rebaseline_source',
      'web_fetch',
      'rlm_query',
      'shell_exec',
      'upload_image',
      'ask_user',
    ]);

    it('keeps every section when every tool id is available', () => {
      const result = filterHarnessSections(buildSystemPrompt(), ALL_TOOL_IDS);
      for (const tag of [
        'identity',
        'memory',
        'wiki_navigation',
        'web_fetch',
        'wiki_ingest',
        'rlm',
        'shell_execution',
        'image',
        'ask_user_routing',
      ]) {
        expect(result).to.include(`<${tag}>`);
        expect(result).to.include(`</${tag}>`);
      }
    });

    it('never removes identity or memory regardless of the available set', () => {
      const result = filterHarnessSections(buildSystemPrompt(), new Set());
      expect(result).to.include('<identity>');
      expect(result).to.include('<memory>');
    });

    it('removes wiki_navigation and wiki_ingest when no wiki tool is available, keeping web_fetch', () => {
      const available = new Set(['web_fetch', 'rlm_query', 'shell_exec', 'ask_user']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.not.include('<wiki_navigation>');
      expect(result).to.not.include('<wiki_ingest>');
      expect(result).to.include('<web_fetch>');
    });

    it('keeps wiki_navigation when any one wiki tool is available', () => {
      const available = new Set(['wiki_locate']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.include('<wiki_navigation>');
    });

    it('gates wiki_ingest independently of web_fetch — bound web_fetch, unbound wiki_create_page', () => {
      const available = new Set(['web_fetch', 'wiki_search']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.include('<web_fetch>');
      expect(result).to.include('<wiki_navigation>');
      expect(result).to.not.include('<wiki_ingest>');
    });

    it('gates wiki_ingest independently of web_fetch — bound wiki_create_page, unbound web_fetch', () => {
      const available = new Set(['wiki_create_page']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.include('<wiki_navigation>');
      expect(result).to.not.include('<web_fetch>');
      expect(result).to.not.include('<wiki_ingest>');
    });

    it('includes wiki_ingest only when both web_fetch and wiki_create_page are available', () => {
      const available = new Set(['web_fetch', 'wiki_create_page']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.include('<wiki_ingest>');
    });

    it('removes rlm when rlm_query is unavailable', () => {
      const available = new Set(['web_fetch']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.not.include('<rlm>');
    });

    it('removes shell_execution when shell_exec is unavailable', () => {
      const available = new Set(['web_fetch']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.not.include('<shell_execution>');
    });

    it('removes image when upload_image is unavailable', () => {
      const available = new Set(['web_fetch']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.not.include('<image>');
    });

    it('keeps image when upload_image is available', () => {
      const available = new Set(['upload_image']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.include('<image>');
    });

    it('removes ask_user_routing when ask_user is unavailable', () => {
      const available = new Set(['web_fetch']);
      const result = filterHarnessSections(buildSystemPrompt(), available);
      expect(result).to.not.include('<ask_user_routing>');
    });

    it('leaves no triple-newline runs or dangling whitespace after removing sections', () => {
      const result = filterHarnessSections(buildSystemPrompt(), new Set());
      expect(result).to.not.match(/\n{3,}/);
      expect(result).to.equal(result.trimEnd());
    });
  });
});
