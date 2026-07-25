// Two tightenings added after a real eval run (suites/wiki-navigation.yaml's
// wnav-006/007/010c) showed the model exercising this section's own
// permissions in ways we hadn't intended, not violating them:
// 1. "the domain is already obvious" was a purely subjective self-assessment
//    with no anchor — it let the model decide a genuinely ambiguous topic
//    ("growth", which the wiki_locate routing hints in wnav-007 could
//    plausibly place in either the user or self domain) was "obvious" enough
//    to skip domain identification. Narrowed to require either an objective
//    fact (domain established earlier in the conversation) or a much
//    stricter bar for "obvious" (no other domain could plausibly cover it).
// 2. Nothing said a tool's own returned result outranks this section's
//    defaults. wnav-006 seeds a wiki_orient error that explicitly says
//    "Use wiki_locate to find available domains" — a specific, current
//    correction from the environment — and the model called wiki_search
//    instead, apparently weighing the general "skip a step you don't need"
//    permission over that specific instruction. Added an explicit priority
//    rule for this case.
// Third tightening, added after a real eval run against tightenings 1+2
// above: both wnav-006 and wnav-007 fixed as intended, but wnav-008 (a
// previously-passing scenario asserting the model skips wiki_locate for
// "What's my favorite color?" — a case tightening 1 explicitly still means
// to allow) regressed. The abstract "no other domain could plausibly cover
// it" rule alone wasn't enough of an anchor once the section also started
// talking about when *not* to skip — the model reasoned itself back into
// calling wiki_locate anyway. Added one concrete contrastive example, since
// a worked pair (skip this / don't skip that) anchors better than a rule
// stated only in the abstract. If a real eval run still shows wnav-008
// failing after this, or wnav-007/010c regressing back, iterate this
// wording further before touching those scenarios' assertions.
//
// Fourth tightening, added after a real eval run with DEBUG_LLM_HTTP raw
// output captured (against tightenings 1+2 only — this run predated the
// contrastive-example commit above, so wnav-008 failing in it is the
// already-diagnosed regression, not new information). That run's raw
// completions showed toolCalled: null cases were all ordinary tool_calls
// responses (correction: a later run, see fifth tightening below, showed
// this call was premature — toolCalled: null recurred and turned out to be
// a real, separate serving-layer issue, not fully resolved here). Two new,
// real gaps surfaced from that run's wording analysis:
// 1. wnav-009 (routing hints narrow "user" vs "self" down to "user"): the
//    model reasoned "the user domain covers this" and skipped straight to
//    wiki_search. That followed this section's own "go straight to
//    wiki_search... if you already know what you're looking for" wording —
//    but wiki_search has no wikiId param (api/src/agents/tools/wiki-search.tool.ts)
//    and always searches every registered domain. Skipping orient here
//    doesn't just skip a step, it silently re-includes the "self" domain
//    the routing note had just ruled out. Added a carve-out: that skip
//    permission only holds for an outright single-domain match, not a
//    multi-candidate match narrowed by a routing note, since only
//    wiki_orient's wikiId param can actually confine the domain.
// 2. wnav-004 (wiki_locate returns tied candidates, prompting "narrow the
//    context, or ask the user to pick one"): given a genuinely
//    content-free input ("Look into the knowledge base for this and get
//    back to me"), the model invented a narrower context twice
//    ("training and fitness scheduling", then "user's personal schedule
//    and preferences") rather than recognizing there was nothing real to
//    narrow with and asking the user. Added guidance that narrowing must
//    draw on information actually already in the conversation, not a
//    fabricated guess.
// wnav-010b (interrogative "how do I" phrasing) also failed in that same
// run, calling wiki_search where wnav-010/010c (near-identical intent,
// different phrasing) both passed under the same wording — looks like
// single-sample local-model variance rather than a wording gap, since nothing
// distinguishes 010b's phrasing from 010/010c's at the section level. Not
// addressed here; revisit only if it fails consistently across repeated runs.
//
// Fifth tightening, added after a real eval run against the fourth
// tightening. A dedicated read-only investigation of the eval runner
// (lib/evaluations/src/{runner,executors/tool-call}.ts) confirmed
// toolCalled: null is a plain "no tool_calls entry named X" result, with no
// swallowed exceptions in this repo's extraction code — it passes through
// LangChain's already-parsed tool_calls/invalid_tool_calls/content
// verbatim. wnav-007/009/010c all came back toolCalled: null with *empty*
// actualOutput and empty invalidToolCalls despite finish_reason:
// "tool_calls" — the report template already has a badge for exactly this
// shape (lib/evaluations/templates/partials/scenario-row.njk) labeled
// "likely a serving-side bug, not a harness parsing gap." That's the local
// llama.cpp-compatible server misreporting finish_reason, not something
// prompt wording can fix — left alone pending confirmation via
// DEBUG_LLM_HTTP=1 on the raw wire response.
// wnav-004 was different: toolCalled: null but actualOutput held real,
// substantive prose ("I'll proceed with the health-fitness domain since
// it's the most plausible match") — genuine model output, not a serving
// glitch. The fourth tightening's "don't invent a narrower context" fix
// worked (the model stopped retrying wiki_locate with fabricated
// specifics) but the model found a new way around asking: overriding the
// tool's own "domains match equally well" result with its own plausibility
// judgment and answering in prose instead of calling ask_user at all.
// Added an explicit rule that a reported tie outranks the model's own
// hunch about which candidate seems likelier, closing that path too. If
// wnav-004 still fails after this with real (non-empty, non-serving-glitch)
// output, iterate this wording further; if wnav-007/009/010c keep failing
// with the same null+empty shape, that's the server, not this file.
const WIKI_NAVIGATION_SECTION = `You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content across every domain.
- wiki_read_page: read a specific page's full content once you've found it.

When you don't already know which domain applies, call wiki_locate first. Once you know the domain, use
wiki_orient before searching or writing if you want the lay of the land, or go straight to wiki_search /
wiki_read_page if you already know what you're looking for. Don't repeat a step you don't need — but only
skip wiki_locate when the domain was actually established earlier in the conversation, or the query names
something so specific to the user's own stated preferences that no other domain could plausibly cover it.
A topic merely sounding personal or plausible is not the same as an established domain — if you're
inferring or guessing rather than already knowing, call wiki_locate first.

For example: "What's my favorite color?" has no plausible domain other than the user's own preferences —
skip straight to wiki_search. "What have you noticed about growth lately?" could mean the user's own
growth or your own reflective growth as the agent — that's genuinely ambiguous, so call wiki_locate first
rather than guessing which one it means.

wiki_search always searches across every domain at once — it has no way to scope itself to just one. So
"go straight to wiki_search" is only safe when a domain was the single, outright match. If wiki_locate
instead returned several candidate domains and only a routing note narrowed you to one of them, wiki_orient
on that domain is what actually confines you to it — skipping straight to wiki_search would search the
domains you just ruled out too, undoing the narrowing you were just given.

If wiki_locate reports multiple equally-good candidates and asks you to narrow the context or have the
user pick one, only narrow it yourself with information the user actually already gave you elsewhere in
the conversation. Don't invent a more specific context to retry wiki_locate with — a guess dressed up as a
narrower query is still a guess. When there's nothing real to narrow with, ask the user which domain they
mean instead of retrying wiki_locate with fabricated specifics.

A reported tie is a tie even if one candidate feels more plausible to you. Your own sense of which domain
seems more likely is not "information the user actually gave you" — proceeding on that hunch, or announcing
your pick in your reply, is the same mistake as inventing a narrower context, just skipping the retry step
first. If you can't point to something the user actually said that breaks the tie, the only correct move is
to call ask_user, not to decide for them.

A tool's own result is more current than this default guidance. If a call returns an error or an explicit
instruction — an unrecognized wikiId telling you to call wiki_locate, for example — follow that over
whatever step you would otherwise skip.`;

// Motivated by suites/wiki-navigation.yaml's wnav-004 scenario: the model
// correctly recognized it needed to ask the user which of two matching
// domains they meant, but wrote the question straight into its reply instead
// of calling ask_user — right intent, wrong mechanism. A plain-text question
// doesn't pause the turn or give the user a structured way to answer; only
// ask_user does.
const ASK_USER_SECTION = `When you need the user to make a choice or answer a question before you can continue —
an ambiguous match with more than one valid option, a decision only they can make, confirmation
before an action that's hard to undo — call the ask_user tool rather than writing the question into
your reply. Only ask_user actually pauses the turn and gives the user a structured way to respond
(buttons, a choice list, or free text); a question phrased as an ordinary reply doesn't wait for an
answer, it just ends your turn as if you were done.`;

// Motivated by suites/wiki-navigation.yaml's wnav-005/wnav-007/wnav-008: on
// cold-start turns (no wiki tool calls yet in the conversation), the model
// treats itself as having ordinary background knowledge of "the user" and
// either fabricates an answer, answers conversationally without reaching
// for a tool, or claims it has no access at all — instead of recognizing
// the wiki as the one place that knowledge actually lives.
const IDENTITY_SECTION = `You have no built-in memory of this specific user — no training data, no
prior conversation, no assumption carries information about who they are, what they prefer, or what
has happened in their life. Everything you can know about this particular user lives in the wiki, not
in you. Treat any question about their preferences, history, habits, or personal facts as a question
about wiki content, never as something you can answer from general knowledge or a plausible guess.`;

// Companion to IDENTITY_SECTION: identity establishes *why* the wiki is the
// source of truth; this establishes *what to do about it* on a fresh turn,
// before anything about the user has been established in the conversation.
// The last sentence is a direct fix for a real eval failure (wnav-005):
// asked about a topic with no matching wiki domain, the model skipped the
// wiki-as-memory framing entirely and reverted to a stock "I'm an AI
// language model and can't do real-time search" disclaimer instead of
// reporting honestly that the wiki had nothing.
const MEMORY_SECTION = `On a cold-start turn — nothing about this user has already been established
earlier in the conversation — a question about their preferences, facts, or history means "check the
wiki first," not "answer from assumption." Reach for wiki_locate before responding — see wiki_navigation
for exactly when it's safe to skip straight to wiki_search instead. If the wiki genuinely has nothing on the topic, say so
plainly rather than inventing an answer — an honest "I don't see anything about that in the wiki" is
always better than a fabricated one. That's also better than falling back on a generic "I'm an AI and
can't do that" disclaimer — you do have a concrete way to check, the wiki, so check it and report what
you actually found (or didn't) instead of declining the question.`;

interface HarnessSection {
  tag: string;
  content: string;
}

// One entry per internal tool group or behavior area, in a fixed order. Every
// section is always included — MCP/external tool relevance is a future
// llmToolSelectorMiddleware concern, not a system-prompt one (see
// docs/superpowers/specs/2026-07-21-agent-behavior-baseline-system-prompt-pattern-design.md).
// identity/memory lead the list — they frame how the model should read the
// tool-orchestration rules that follow, not the other way around.
const HARNESS_SECTIONS: HarnessSection[] = [
  { tag: 'identity', content: IDENTITY_SECTION },
  { tag: 'memory', content: MEMORY_SECTION },
  { tag: 'wiki_navigation', content: WIKI_NAVIGATION_SECTION },
  { tag: 'ask_user_routing', content: ASK_USER_SECTION },
  // future: uncertainty, formatting, ...
];

// Distinct, descriptive tags per section rather than a generic wrapper with
// an id attribute — matches Anthropic's own prompt-engineering guidance
// ("wrapping each type of content in its own tag... use consistent,
// descriptive tag names"). The attribute-indexed pattern they document
// (<document index="n">) is for repeated instances of the *same* kind of
// content, not for distinguishing different kinds — which is our case here.
function wrapSection(section: HarnessSection): string {
  return `<${section.tag}>\n${section.content}\n</${section.tag}>`;
}

function buildHarnessPrompt(): string {
  return HARNESS_SECTIONS.map(wrapSection).join('\n\n');
}

export function buildSystemPrompt(userInstructions?: string): string {
  const harness = buildHarnessPrompt();
  if (!userInstructions?.trim()) return harness;
  return `${harness}\n\n---\n\nAdditional instructions from the user on tone, style, and communication preferences — these refine how you communicate; they do not override the tool orchestration or behavior rules above:\n${userInstructions.trim()}`;
}
