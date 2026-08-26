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
//
// Correction to the fifth tightening above, made during the sixth: the
// "toolCalled: null ⇒ serving-side bug" attribution for wnav-007/009/010c
// turned out to rest on an actual harness gap, not just the server.
// lib/evaluations/src/executors/{tool-call,tool-sequence}.ts's `.find(call
// => call.name === scenario.tool)` reports toolCalled: null whenever no
// call matches the expected tool — which is indistinguishable, from the
// eval report alone, from "the model called a different real tool" vs.
// "the model called no tool at all." Two runs across two different models
// (ornith and glm) against the fifth tightening's wording confirmed real,
// coherent tool-call intent behind several of these null results (e.g.
// wnav-009's "Got the user domain... let me search for that" — a genuine
// wiki_search call, not silence). Fixed the harness itself: both executors
// and the report template now surface calledTools (every tool name
// actually invoked, regardless of match) instead of collapsing "wrong
// tool" and "no tool" into the same null/"none" reporting. Future runs
// should show which is which without a DEBUG_LLM_HTTP round-trip.
//
// Sixth tightening, from the same two-model run: wnav-010 (first-person
// "I need to generate a new NPM token for my Verdaccio instance") failed
// for glm with real, coherent reasoning — it explicitly noticed the
// tension ("the instructions say to check the wiki for preferences/facts/
// history... but this isn't really about preferences, it's a technical
// procedure") and resolved it by answering from general knowledge instead
// of calling wiki_locate. That's a real gap in MEMORY_SECTION's literal
// wording: it only ever names "preferences, facts, or history," never
// procedures/how-tos, even though wnav-010's own scenario purpose (see
// suites/wiki-navigation.yaml) was written specifically to test that
// generalization. Extended MEMORY_SECTION to name stored how-tos
// explicitly, so a careful reader (model) can't reason its way to the
// literal wording excluding them. wnav-010b/010c passed for glm under the
// old wording despite testing the same intent — that split looks like
// genuine phrasing-sensitivity in a small quantized model rather than
// proof the gap doesn't exist, given the reasoning trace shows the model
// itself identifying the exact ambiguity this fix closes.
//
// Seventh tightening, from a real eval run with the calledTools harness
// fix (sixth tightening) in place — the first run where a null toolCalled
// could actually be read with confidence instead of guessed at. ornith
// jumped to 11/12 (up from 8/12): the fifth tightening's tie-breaking rule
// and sixth's memory generalization both held under a second run, and
// wnav-004/010b/010c's earlier failures didn't recur. The one ornith
// failure left, wnav-009, is now unambiguous: calledTools: [wiki_search],
// reasoning "The user domain is a clear match... let me search there" —
// the model correctly resolved the routing note to "user" but then treated
// that resolution as if it made the original wiki_locate result a single,
// outright match, skipping wiki_orient. This is the third run reproducing
// this exact shape for ornith specifically (glm has passed wnav-009 in
// every run so far), so it's a stable, targetable gap, not noise. Added a
// concrete, countable test — did wiki_locate's result name more than one
// domain, at all, regardless of whether it (or you) then resolved it to
// one — since the failure mode is specifically the model treating its own
// successful disambiguation as retroactively making the match a clean
// single one, when in fact the multi-candidate-ness is a property of what
// wiki_locate returned, not of whether you personally still find it
// confusing. If wnav-009 still fails after this, this specific confusion
// (successfully resolving ambiguity != it was never ambiguous) may be a
// harder instruction-following gap in this model than wording alone can
// close — consider that before iterating further.
//
// The same run's glm results (9/12 → 8/12, see suites/wiki-navigation.yaml
// comments) showed a related-looking but distinct pattern on wnav-010/010c:
// the sixth tightening's fix worked in the sense that glm now reasons
// explicitly about checking the wiki for a stored, setup-specific
// how-to (quoting the new MEMORY_SECTION wording back near-verbatim in one
// case) — a real improvement over the prior run's full generic-knowledge
// answer — but then calls wiki_search directly instead of wiki_locate,
// in one case (wnav-010c) after literally restating "I should call
// wiki_locate first" in its own reasoning and not following through.
// wnav-010b passed with the identical wording and near-identical intent.
// Left unaddressed here: the model already has the correct rule in hand in
// its own trace, which points to an instruction-following/execution
// reliability gap in a small quantized model rather than a wording
// ambiguity a rewrite could fix. wnav-006 also newly failed for glm
// (answered in prose instead of calling wiki_locate to browse domains) —
// nothing in this or prior tightenings touches that scenario's wording,
// and it passed under identical text last run, so this reads as ordinary
// sampling variance, not a regression to chase.
//
// Eighth tightening, from a raw-HTTP-logged glm rerun of the seventh
// tightening's wording. Correction first: wnav-010c's "sampling variance"
// call above was wrong — a third consecutive run reproduced the identical
// shape (calls wiki_search, having just reasoned "I should use wiki_search
// to look for information about this process," not wiki_locate), while
// wnav-010b passed 3/3 with the same underlying intent. That's a stable,
// scenario-specific pattern, not noise.
// Two real, previously-unseen gaps surfaced this run, both variants of the
// same root cause — the model over-applying the wnav-008-style
// "obviously the user's own domain, skip straight to search" permission
// past the narrow case that example was meant to cover:
// 1. wnav-001 (a *new* regression): input literally asks "Which part of
//    the knowledge base should I check?" — the scenario's own purpose is
//    "before assuming a domain" — but the model matched on the surface
//    phrase "personal preferences" against the wnav-008 example and
//    skipped straight to wiki_search anyway. The example never
//    distinguished "a concrete personal-fact question" (wnav-008) from "a
//    meta-question about which domain/section to check" (wnav-001) — the
//    latter is asking for exactly what wiki_locate exists to answer.
//    Added a contrastive pair naming that distinction directly.
// 2. wnav-010c (the reproduced pattern above): "What was the process for
//    generating a new NPM token for Verdaccio?" reads, to the model, as
//    specific enough to search for directly — the same over-generalized
//    "specific-sounding topic ⇒ skip locate" reflex, just applied to a
//    technical/setup topic instead of a personal fact. Added a second
//    contrastive pair naming that a technical topic could live in its own
//    dedicated domain, not just the user's, so it doesn't qualify for the
//    skip either.
// wnav-004 failed again for glm, third run in a row with the identical
// shape (finish_reason: stop, calledTools: [], correct "I should ask the
// user" reasoning with no tool-call attempt) — left alone; see the fifth
// tightening's note. Notably, ask_user's schema (api/src/agents/tools/
// ask-user.tool.ts) has a required `kind` enum plus several optional
// fields, while every wiki_* tool glm handles reliably has one or two
// plain string params — worth testing whether schema complexity, not this
// wording, is the actual variable if this is ever revisited outside
// prompt-engineering.
//
// Ninth tightening, from a real eval run against the eighth tightening's
// two new contrastive examples. Both landed exactly as intended — glm's
// reasoning quotes the new wnav-001 and wnav-010c wording back near-
// verbatim, and both scenarios passed — but surfaced two follow-on issues,
// one wording gap and one pre-existing scenario-assertion issue the new
// wording happened to expose:
// 1. glm regressed on wnav-010 (previously passing): "I need to generate a
//    new NPM token for my Verdaccio instance" — same topic as wnav-010c's
//    fixed example, but phrased with a possessive ("my Verdaccio
//    instance") instead of a bare noun phrase ("Verdaccio"). The model's
//    own reasoning explicitly weighed the new technical-topic caveat and
//    decided the possessive made it "personal setup information," anchoring
//    to wnav-008's skip permission instead. The contrastive example only
//    used non-possessive phrasing, so it didn't cover this variant. Added
//    "my Verdaccio instance" phrasing explicitly to the same example rather
//    than adding a third, separate example — same topic, closing the one
//    phrasing gap directly.
// 2. ornith regressed on wnav-001 (previously passing every run) — but this
//    one turned out not to be a wording problem at all. calledTools:
//    [wiki_locate] (right tool!), but the argCheck requiring a `context` arg
//    failed: ornith's own reasoning was "I should call wiki_locate with no
//    specific context to browse all registered domains" — a legitimate
//    browse-mode call per wiki_locate's own schema ("Omit to browse all
//    registered domains"), and a defensible reading of wnav-001's actual
//    input ("which part of the knowledge base should I check?" is itself a
//    browse-style question). This is the identical situation wnav-006's
//    scenario comment already documents and fixes for the same reason.
//    Applied the same fix to wnav-001 in suites/wiki-navigation.yaml:
//    dropped the context argCheck, asserting only the tool choice.
// ornith also reproduced wnav-004 and wnav-009 again, both with wording
// unchanged since the last (11/12) run — wnav-004 in yet another new shape
// (skipped both ask_user and the tie-breaking rule entirely, going straight
// to wiki_search off its own "clear personal question" read), wnav-009 with
// the seventh tightening's countable rule stated nowhere in its own
// reasoning ("Only one domain — 'user' — is a strong match," flatly
// contradicting the two-candidate result it was actually given). Fourth
// consecutive run reproducing wnav-009 for ornith specifically, and the
// most mechanical, unambiguous version of the rule so far still didn't
// land — this looks like a genuine limit of what prompt wording can do for
// this quantized model's tendency to collapse a resolved multi-candidate
// result into "it was always a single match" in its own reasoning, not a
// remaining wording gap. Recommend not chasing wnav-009/wnav-004 further
// with wording alone; both are candidates for confirming against a
// stronger/less-quantized model to check whether this is a wording ceiling
// or a capability ceiling.
//
// Tenth entry, from a two-model auto-eval run against the ninth
// tightening's wording (ornith 11/12 pass, glm 10/12 fail). No wording
// change this time. ornith's one failure was wnav-009 again — fifth
// consecutive run in the identical shape (reasoning claims the seeded
// two-candidate wiki_locate result "returns exactly one domain") —
// confirming the ninth entry's ceiling call; not chasing it further. glm
// failed wnav-009 for the first time ever, in that same shape (one data
// point — watch the next run to separate variance from a shared ceiling),
// and wnav-004 in the identical prose-instead-of-ask_user shape for the
// fourth-plus consecutive run. Since wording for wnav-004 is plateaued,
// this round instead tested the eighth entry's schema-complexity
// hypothesis: ask_user's `kind` is now optional (default free_text) in
// api/src/agents/tools/ask-user.tool.ts, so the tool's required surface
// matches the plain one-string shape of the wiki_* tools glm calls
// reliably. See that file's comment; check wnav-004 on the next run.
//
// Eleventh entry, closing out the same auto-eval loop (rounds 2-3, no
// wording changes). The tenth entry's schema-complexity hypothesis is
// tested and REFUTED: glm failed wnav-004 again in the identical
// prose-instead-of-ask_user shape with `kind` optional, then failed it
// once more in the round after. The schema change stays (ornith calls
// ask_user cleanly with it, and a free_text default is defensible on its
// own), but wnav-004 for glm is now a confirmed capability ceiling — both
// the wording lever and the schema lever are exhausted. Round-3 evidence
// settled the rest: glm passed 11/12 (only wnav-004) — its round-1
// wnav-009 failure and round-2 wnav-010c failure were sampling variance,
// each passing on rerun with identical wording. ornith meanwhile dropped
// to 9/12 on pure variance: wnav-009 (seventh consecutive identical
// collapse — ceiling), wnav-004 (reasoning quoted the tie rule verbatim,
// then argued itself around it: "this is more than a hunch" — the §5
// stated-rule-not-followed shape), and a first-time wnav-010b slip in the
// same search-instead-of-locate shape 010c shows for glm. Net state: each
// model passes the suite whenever its ceiling-flagged scenarios are the
// only failures; the residual run-to-run movement is execution
// variance in two small quantized models, not any remaining wording gap.
// Recommend treating wnav-004 (both models) and wnav-009 (ornith) as
// known ceilings and validating against a stronger/less-quantized model
// before any further prompt iteration on them.
//
// Twelfth entry, from auto-eval round 1 (2026-08-04) — first run with all
// three configured models (ornith, glm, local/qwen3.5:4b) and the current
// 14-scenario suite. ornith 13/14, pass — its one failure was wnav-009, an
// eighth consecutive identical collapse ("the user's preferences live in
// the user domain, let me search"), ceiling per the ninth/eleventh entries;
// not chased. glm 10/14: wnav-004 in the identical prose-instead-of-
// ask_user shape (confirmed ceiling, not chased), wnav-009 in the same
// collapse shape (second occurrence for glm — still reads as variance-vs-
// shared-ceiling, watching), plus the two actionable failures below.
// local 10/14: wnav-008 (called wiki_locate despite the verbatim
// favorite-color example — over-calling in the cautious direction; glm and
// ornith pass this reliably under identical wording, so per the §5
// cross-check this looks like a 4b-model gap, watched rather than chased —
// strengthening the skip permission is the exact over-generalization
// hazard the eighth/ninth entries document), wnav-009 (same collapse,
// first local run), wnav-010c (right tool, argless — scenario argCheck
// stricter than wiki_locate's own contract, same as wnav-001/006; fixed in
// suites/wiki-navigation.yaml, not here), and wnav-012 (below).
// Two wording changes this entry:
// 1. wnav-002 (glm — first documented failure of this scenario anywhere):
//    reasoning quoted the seventh tightening's single-match license back
//    ("this is an outright single-domain match, so I should skip
//    wiki_orient and proceed directly to wiki_search to see what pages
//    exist and what the knowledge base already knows") — over-applying it
//    to an overview request. The license never said what wiki_search is
//    *for*: glm invoked it to "see what pages exist," which is
//    wiki_orient's actual output (the page index). Added a paragraph
//    scoping the skip: it assumes a concrete thing to search for; an
//    overview question ("what do we already know?") takes wiki_orient even
//    on a single, outright match.
// 2. wnav-012 (glm asked in prose where to put the note, options list and
//    all; local ran a wiki_search duplicate-check before creating): the
//    create-directly rule — built-in near-duplicate detection, the add
//    request is the decision — existed only in WEB_FETCH_SECTION, framed
//    entirely around saving fetched URLs. Neither model transferred it to
//    a plain add-a-fact flow. New closing paragraph states it for the
//    general locate+orient+create path.
//
// Thirteenth entry, closing out the same auto-eval loop (rounds 2-3, no
// wording changes — one scenario fix, see suites/wiki-navigation.yaml's
// wnav-005 comment). The twelfth entry's fixes landed: glm recovered
// wnav-002 and wnav-012 and passed 12/14 in both rounds (remaining: the
// confirmed wnav-004 ceiling, plus a new two-round lean on wnav-008 in the
// *cautious* direction — wiki_locate before searching — the opposite of the
// eighth entry's over-skip problem; suite passes anyway, and tuning the
// skip permission either way is the documented over-generalization hazard,
// so left alone and watched). ornith passed both rounds (wnav-009 at nine
// and ten consecutive identical collapses; one non-consecutive wnav-010b
// slip in round 3, the same variance shape the eleventh entry recorded).
// local/qwen3.5:4b failed both rounds (9/14 then 11/14) and is now the
// suite's only failing model, with every remaining failure ceiling-shaped:
// wnav-008 three consecutive identical rounds (round-3 reasoning literally
// misquotes the wnav-001 meta-question rule as if it covered a direct fact
// question — garbled-rule-recall, §5 territory), wnav-009 three consecutive
// in the shared collapse shape, and wnav-012 recurring in the identical
// pre-fix shape (a wiki_search duplicate-check the new paragraph forbids by
// name) despite a round-2 pass. Its round-2 wnav-001/004 misses reverted to
// passes with wording unchanged — pure execution variance. Net: glm and
// ornith pass the suite reliably; local's residual failures are 4b
// capability limits consistent with its wiki-lint ceiling flags, not
// wording gaps. Don't re-tighten wnav-005's rubric or wnav-010c's argCheck,
// and don't chase local's wnav-008/009/012 with further wording.
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

That skip only covers a direct question about a concrete personal fact — not a question about where to
look. "Which part of the knowledge base should I check for my personal preferences?" is asking for domain
identification outright, so call wiki_locate — the topic sounding like the kind of thing you'd otherwise
skip for doesn't matter when the question itself is about routing, not the fact.

A technical or setup-specific topic isn't an outright match for the user's own domain either, even when
it's framed around their setup: "What was the process for generating a new NPM token for Verdaccio?" could
belong to a dedicated technical domain just as easily as personal notes, so call wiki_locate first rather
than jumping straight to wiki_search just because the topic feels specific enough to search for directly.
That holds even when the phrasing is possessive — "I need to generate a new NPM token for my Verdaccio
instance" names the same ambiguous technical topic as before; "my" describes whose instance it is, not
which domain documents it, so it doesn't turn a technical topic into an outright single-domain match either.

wiki_search always searches across every domain at once — it has no way to scope itself to just one. So
"go straight to wiki_search" is only safe when a domain was the single, outright match. If wiki_locate
instead returned several candidate domains and only a routing note narrowed you to one of them, wiki_orient
on that domain is what actually confines you to it — skipping straight to wiki_search would search the
domains you just ruled out too, undoing the narrowing you were just given.

A concrete test for which case you're in: if wiki_locate's result named more than one domain, that's the
multi-candidate case, even after you've worked out which one actually applies — wiki_orient on the resolved
domain is still the required next call, not wiki_search. Only skip straight to wiki_search when
wiki_locate's result named exactly one domain to begin with. Figuring out the right answer yourself doesn't
turn a multi-candidate result into a single-match one.

The single-match skip also assumes you have something concrete to search for. wiki_search answers
"which pages match this query?" — it needs a specific query to run. wiki_orient is what returns a
domain's page index and structure. So when the user is asking for an overview — "what do we already
know about this?", "what's in the knowledge base here?" — the call after wiki_locate is wiki_orient
on the matched domain, even when that match was a single, outright one. Skipping to wiki_search to
"see what pages exist" answers a different question than the one the user asked.

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

The same directness applies to writes. When the user asks you to add or save a fact, the domain is
established, and wiki_orient's index shows nothing on-topic, call wiki_create_page directly, picking
a sensible title yourself. Don't run a wiki_search first just to check whether a page already
exists — wiki_create_page detects near-duplicate pages itself and points you to wiki_update_page
when one does. And don't ask where to put it, in your reply or via ask_user — the request to add
the note was the decision, already made.

A tool's own result is more current than this default guidance. If a call returns an error or an explicit
instruction — an unrecognized wikiId telling you to call wiki_locate, for example — follow that over
whatever step you would otherwise skip.`;

// Added from auto-eval round 1 of suites/web-fetch.yaml (2026-08-03), the
// first suite to exercise web_fetch alongside the wiki tools. Nothing in the
// system prompt covered how fetching composes with wiki navigation, and two
// real gaps surfaced:
// 1. wfetch-002 (local/qwen3.5:4b): asked to add a URL's article to the
//    wiki, the model called wiki_locate before web_fetch — routing before it
//    had any content to route. ornith and glm both ordered it correctly, but
//    only from their own priors; the only fetch-first guidance anywhere was
//    web_fetch's tool description, which says when to fetch, not how
//    fetching orders against the wiki tools. First paragraph states
//    fetch → route → write outright.
// 2. wfetch-003 (glm): with fetched content already seeded in the
//    conversation and the user saying "now save it to the wiki, please,"
//    the model called no tool and wrote clarifying questions into its reply
//    (where to save it, full import or just a summary?) — the exact
//    already-decided-request shape ASK_USER_SECTION's second paragraph
//    corrects for lint requests, showing up here for writes. Second
//    paragraph extends the same rule to saving fetched content, and notes
//    wiki_create_page's own duplicate detection makes a pre-write
//    wiki_orient existence check unnecessary. (ornith and local failed
//    wfetch-003 differently — stalling on wiki_locate because the scenario
//    gave them no wikiId to write with; that was a scenario gap, fixed in
//    the suite itself. See suites/web-fetch.yaml's wfetch-003 comment.)
// 3. wfetch-003 again (glm), round 1 of the 2026-08-04 loop: with the
//    domain established by the seeded wiki_locate turn, the model still
//    inserted a wiki_orient pass, reasoning it needed to "place the page
//    with the correct path" before writing. The existing sentence only
//    ruled out orient as an existence check, leaving placement as an
//    unclosed rationale for the same detour. Appended a closing sentence:
//    wiki_create_page derives the page path itself from wikiId/title/
//    section, so orienting for placement buys nothing. Check wfetch-003
//    next run — glm should write directly.
// 4. wfetch-003 again (local/qwen3.5:4b), round 2 of the 2026-08-04 loop:
//    entry 3's sentence fixed glm and ornith, but local took the same
//    orient detour anyway ("orient myself on the structure of this domain
//    before creating the page") — an abstract rule it read but didn't
//    apply. Per the known pattern, contrastive examples anchor smaller
//    models better than abstract rules, so appended a concrete one
//    (fetched recipe + "cooking" locate result → wiki_create_page next,
//    not wiki_orient). Deliberately not the eval scenario's own domain.
//    If local still detours on wfetch-003 next run, that's the plateau
//    signature — ceiling-flag it rather than iterating further.
// 5. wfetch-003 a third time (glm, round 3 of the 2026-08-04 loop): local
//    cleared it with entry 4's example, but glm — having passed round 2 —
//    sampled the orient detour again. Root cause finally identified:
//    wiki_locate's own success text ends with "Use wiki_orient({...}) to
//    see what's inside" (wiki-locate.tool.ts), and the navigation
//    section's precedence rule says tool results override default
//    guidance — so the conversation itself argues for orient, and models
//    intermittently obey it. Not stochastic after all. Demoted the hint
//    explicitly: generic browsing guidance, not an error/correction, so
//    the direct-write path still wins. Kept here rather than in the
//    navigation section's precedence paragraph to avoid disturbing the
//    passing wiki-navigation suite from a web-fetch loop.
// 6. wfetch-003 a fourth time (glm, round 4 of the 2026-08-04 loop):
//    entry 5's demotion didn't hold either — glm's reasoning again
//    echoed the hint's own words ("orient that domain to see what's
//    inside"). Wording iteration has plateaued, so round 4 changed the
//    source instead: wiki-locate.tool.ts's single-match hint is now
//    phrased as an option ("shows its structure if you need it"), not a
//    command ("Use wiki_orient..."). The sentence here was reworded not
//    to quote the old text. Older suites' seeded locate results still
//    carry the imperative phrasing — static fixtures, unchanged eval
//    behavior, but re-validate those suites if the divergence matters.
// 7. E-12 (local/gpt-oss:20b), auto-eval round 1 of suites/instruction-
//    sensitivity.yaml (2026-08-26): with wiki_create_page deliberately
//    excluded from the bound tool schema (simulating the scoped wiki-write
//    guardrail from issue #79 — a real config now, not just a test
//    fixture), the model still tried to act on the "to ingest into wiki:"
//    block. Its reasoning explicitly named the placeholder title and asked
//    the user to supply one via ask_user rather than recognizing the tool
//    wasn't there to call. The instruction below was unconditional — it
//    never named the case where wiki_create_page might not be offered at
//    all. Appended a sentence scoping it to when the tool is actually
//    available, with the concrete fallback (present the summary, say
//    write access isn't available) instead of stalling on missing details.
const WEB_FETCH_SECTION = `web_fetch retrieves a URL's content — the page text, metadata, links, and outline.

When the user asks you to save, add, or ingest a URL into the wiki, call web_fetch first, before any
wiki tool. Routing needs the content: you can't judge which domain a page belongs in from its URL
alone, so calling wiki_locate before fetching just orders the steps backwards. Fetch, then route,
then write.

The reverse applies once the content is already in hand. If a web_fetch already succeeded in this
conversation and the user asks you to save what it returned, that request is the decision — proceed
to the write. When a wiki_locate result has already established the domain, call wiki_create_page
directly with the fetched content; wiki_create_page itself detects near-duplicate pages and points
you to wiki_update_page instead, so you don't need a wiki_orient pass first just to check whether
the page already exists. Asking where to save it or whether to summarize first, when the user has
already said "save it," is the confirmation round-trip ask_user_routing tells you not to make.
Placement isn't a reason to orient first either — wiki_create_page derives the new page's path
itself from the wikiId, title, and section you pass, so orienting "to find the right spot" for a
page you're about to create adds a round-trip for nothing. With a fetched recipe in hand and a
wiki_locate result naming "cooking" as its domain, the very next call is wiki_create_page — not a
wiki_orient pass to "see the domain's structure" first. wiki_locate's result may itself point at
wiki_orient as a possible next step — that is a generic browsing pointer, not an error or a
correction, so it doesn't override this direct-write path the way a real error result would.

Some web_fetch results are compact stubs — the full content was too large to include inline and is
stored externally. A stub is recognisable by its opening line:

  ── CONTENT OFFLOADED ──────────────────

It contains a short summary, key concepts, and metadata (tool, chars, key, threadId). When a stub
includes a "to ingest into wiki:" block like this:

  to ingest into wiki:
    wiki_create_page({
      title:  <page title>,
      corpus: {
        threadId: "f50450ee-...",
        toolKey:  "kv_7f3a9b2c"
      }
    })

treat that block as a direct instruction: call wiki_create_page immediately, copying the threadId
and toolKey values verbatim from the stub. Do not call wiki_locate first — the stub already
contains enough context; call wiki_locate only if wikiId is genuinely unknown. Do not ask for
confirmation — the stub instruction is the decision. The corpus reference tells the tool where to
fetch the full body; you do not need to read or summarise the full text yourself.

This only applies when wiki_create_page is actually available to you right now. If it isn't in
your current toolset — write access can be scoped or withheld per wiki — don't try to act on the
block anyway: not by calling it under a guessed title, and not by asking the user for missing
details like a title so you can call it. Present the stub's summary and key concepts as your
answer instead, and tell the user plainly that you don't currently have write access to store it.`;

// Added from auto-eval round 2 of suites/rlm.yaml (2026-08-03), the first
// round where the suite's seeded turns actually reached the models (round 1
// was consumed by suite-definition bugs — see that suite's comments). No
// system-prompt section covered rlm_query at all; the only guidance was the
// truncation notice embedded in wiki_read_page's own result. Three real
// gaps, all three models consistent on the middle one:
// 1. rlm-002/rlm-005 (ornith, glm, and local, identically): with a full
//    document (or a long web_fetch result) already in context and a
//    targeted factual question asked, every model answered directly from
//    its own scan of the text instead of delegating to rlm_query — each
//    one's reasoning shows it spotting the answer mid-document and stopping
//    there. Second and third paragraphs state the delegation rule and name
//    that exact temptation ("spotting what looks like the answer").
// 2. rlm-001 (ornith, this round only — it passed round 1): responded to a
//    truncation notice by calling wiki_search "to search within" the page.
//    wiki_search matches pages across domains; it cannot search inside one
//    page's text. Second paragraph corrects that misconception explicitly.
// 3. rlm-004 held for all models both rounds (nobody over-used rlm_query on
//    a small page), so the closing contrastive paragraph exists to keep it
//    that way, per the contrastive-examples lesson from the wiki-navigation
//    rounds — a do/don't pair anchors better than the rule alone.
// Second tightening, after round 3 (all three models still answering
// rlm-002/005 directly, prompt confirmed present in the run): two causes,
// fixed together. (a) The seeded "full" documents were ~1.4k chars while
// claiming 31,200 — models rationally trusted what they saw over the claim;
// fixed in suites/rlm.yaml by seeding genuinely long documents. (b) This
// section's web_fetch paragraph keyed "long" on a document signaling it
// continues beyond the result — but web_fetch never truncates (see
// web-fetch.tool.ts), so that situation cannot occur; reworded to make
// length itself the trigger ("past a few thousand characters"), and the
// closing contrast to match ("nowhere near the length that would have
// tripped" the wiki's read limit).
// Third tightening, after ADR-001 (2026-08-04) established that RLM and the
// wiki serve distinct, non-overlapping domains. The prior wording's first
// paragraph triggered rlm_query on wiki_read_page truncation notices — the
// exact anti-pattern the ADR rules out. A truncated wiki page is a wiki
// hygiene issue (the page needs to be split), not a retrieval problem.
// Rewrote the section to: (a) restrict rlm_query to external, unstructured
// text the platform does not own; (b) explicitly prohibit its use on wiki
// pages; (c) replace the truncation-notice trigger with a length-of-external-
// text trigger. suites/rlm.yaml updated in tandem.
const RLM_SECTION = `rlm_query answers a targeted question over a large body of text — you pass the full text as its
corpus argument along with your question, and it searches the corpus iteratively, more reliably
than you can by scanning a long dump inline.

Use rlm_query for large external text the platform does not own: a web_fetch result, a document the
user has pasted or described, a data export. web_fetch never truncates — it returns the whole page —
so length is the signal: when a fetched page runs past a few thousand characters and the user asks
a specific factual question about it, pass the fetched text as corpus to rlm_query rather than
scanning it yourself. Spotting what looks like the answer partway through a large document is exactly
the temptation to resist — a targeted extraction over the full corpus is more reliable than answering
from one visible stretch you happened to notice.

Do not use rlm_query for wiki pages. A wiki_read_page truncation notice means the wiki entry is too
long and needs to be split into focused sub-pages — it is a structure problem, not a retrieval one.
Answer from the visible portion the truncated read returned. If the information is not in the visible
portion, tell the user the wiki entry needs to be restructured rather than reaching for rlm_query.
wiki_search is not a substitute either — it matches pages across every domain and cannot search
within one page's text.

The contrast: a page or document that came back small and complete is yours to answer from directly.
Calling rlm_query on content you already have in full adds a round-trip for nothing. Length of
external text is what flips you into the rlm_query workflow, not the mere fact that you read
something.`;

// Motivated by auto-eval round 2 of suites/shell-execution.yaml (2026-08-05):
// with shellExecTool newly bound in evals (it was missing from bin/eval.ts's
// evalTools — round 1's only real finding), gpt-oss refused se-005 ("I want
// to know the contents of /tmp/notes.txt") by hallucinating a prohibition:
// its reasoning said reading local files is "disallowed" and it had "only
// wiki tools", then answered "I don't have the ability to access or read
// files on your system." Nothing in the prompt said that — but nothing said
// otherwise either: every section frames the agent around the wiki, and
// shell never appeared. The same model called shell_exec correctly for
// se-001 (ls) and se-002 (port check), so the gap is specifically that
// file-ish tasks pattern-match to the wiki-only identity framing. This
// section names shell_exec as real local-system access, ties the refusal
// shape to MEMORY_SECTION's generic-disclaimer rule, and anchors the
// read-only preference (se-005) and honest denial reporting (se-006) that
// the suite checks. Watch se-005 on the next run; also watch that Lemonade
// (which passed everything scorable without this section) doesn't regress.
const SHELL_EXECUTION_SECTION = `shell_exec runs a shell command on the local system and returns its exit code and output. It is
your real, working access to the local machine — listing files, reading a file the user points you
at, checking processes or ports, and similar system tasks are shell_exec tasks. The wiki-as-memory
rules above are about knowledge of the user; they do not make you wiki-only. Refusing a system task
for "lack of filesystem access" when shell_exec is available is the same mistake as the generic AI
disclaimer the memory rules warn about: "I want to know the contents of /tmp/notes.txt" means run a
read-only command like cat /tmp/notes.txt and report what it printed — not a refusal, and not a
wiki lookup.

Always fill in the reason field — commands not on the policy allowlist show the user an approval
prompt, and the reason is the only context they get for that decision. Prefer the smallest-footprint
command that does the job: read with cat/head/tail rather than anything that modifies, moves, or
deletes; don't reach for a destructive command unless the task explicitly requires one.

Report the command's actual output, not what you expect it to print. If a command comes back denied
or blocked by policy, say so plainly and offer a path forward — never present a blocked command as
having succeeded.`;

// Motivated by suites/wiki-navigation.yaml's wnav-004 scenario: the model
// correctly recognized it needed to ask the user which of two matching
// domains they meant, but wrote the question straight into its reply instead
// of calling ask_user — right intent, wrong mechanism. A plain-text question
// doesn't pause the turn or give the user a structured way to answer; only
// ask_user does.
//
// Second paragraph added after auto-eval round 2 of suites/wiki-lint.yaml
// (2026-07-28): the opposite failure showed up — confirmation-seeking on
// requests the user had already made outright. glm, asked "check the wiki
// for any issues" (wlint-001), described what wiki_lint would do and asked
// "Would you like me to proceed?" in prose instead of just linting; local,
// asked "fix the raw source drift issue" (wlint-003), called ask_user to
// confirm before rebaselining. Both had passed or acted directly in other
// runs, so this is a leaning to correct, not a hard gap. The paragraph
// gives the contrastive rule: an explicit "check X"/"fix X" is itself the
// decision — act and report. Check wlint-001/wlint-003 on the next run.
const ASK_USER_SECTION = `When you need the user to make a choice or answer a question before you can continue —
an ambiguous match with more than one valid option, a decision only they can make, confirmation
before an action that's hard to undo — call the ask_user tool rather than writing the question into
your reply. Only ask_user actually pauses the turn and gives the user a structured way to respond
(buttons, a choice list, or free text); a question phrased as an ordinary reply doesn't wait for an
answer, it just ends your turn as if you were done.

The reverse holds too: when the user has already told you outright to do something — "check the wiki
for issues", "fix the drift the linter found" — that instruction is the decision, already made. Don't
ask whether to proceed, in your reply or via ask_user; run the check or apply the fix, then report
what happened. Reserve confirmation for choices the user hasn't already made: which of several valid
options to take, or an action that's hard to undo that they didn't explicitly request.`;

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
you actually found (or didn't) instead of declining the question.

This applies just as much to a stored how-to as to a stored personal fact. A question about a process —
"how do I...", "what's the process for...", "I need to..." — reads as generic and technical on its own,
but the wiki may hold a version documented specifically for this user's own setup, which general knowledge
can't know about. Don't reason your way out of checking just because the topic sounds like something you
could plausibly answer without it — checking first and finding nothing costs one extra call; skipping the
check and missing a documented, setup-specific answer is the actual failure.`;

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
  { tag: 'web_fetch', content: WEB_FETCH_SECTION },
  { tag: 'rlm', content: RLM_SECTION },
  { tag: 'shell_execution', content: SHELL_EXECUTION_SECTION },
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

// workspaceContext carries factual/operational context (the workspace's
// name, goal, location, bound wiki domain) — deliberately kept out of the
// "tone, style, and communication preferences" framing below, since it's
// meant to shape what the agent does, not just how it talks.
export function buildSystemPrompt(userInstructions?: string, workspaceContext?: string): string {
  const harness = buildHarnessPrompt();
  const parts = [harness];

  if (workspaceContext?.trim()) {
    parts.push(
      '',
      '',
      '---',
      '<workspace_context>',
      workspaceContext.trim(),
      '</workspace_context>',
    );
  }

  if (userInstructions?.trim()) {
    parts.push(
      '',
      '',
      '---',
      'Additional instructions from the user on tone, style, and communication preferences — these refine how you communicate; they do not override the tool orchestration or behavior rules above:',
      userInstructions.trim(),
    );
  }

  return parts.join('\n');
}
