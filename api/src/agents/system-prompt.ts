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
//
// Fourteenth entry, auto-eval round 1 of suites/wiki-write.yaml
// (2026-08-26), the suite's first run since wwrite-006 through wwrite-009
// were added alongside issue #79's scoped wiki-write guardrail (commit
// c5217c1) to test recovery after a wiki_forbidden rejection. All three
// configured models (local, Lemonade, Ornith) failed some subset of those
// four scenarios, and nothing anywhere in this file said how to react to
// that rejection shape at all — the closing paragraph above only covered
// an *unrecognized* wikiId (call wiki_locate), never a *forbidden* one that
// already names the correct wiki. Concretely: local detoured into
// wiki_search "to find the path" on wwrite-007/008 despite the path never
// being in question; Ornith re-explained the restriction and asked "what
// would you like to do?" on wwrite-006/007/008 even though the user's next
// turn ("Okay, use the right one then") was already the confirmation the
// existing ask_user_routing "already-decided-request" rule is meant to
// catch — it just wasn't written broadly enough to cover a rejection-and-
// retry shape, only a plain add/save request. Added a new paragraph right
// after the existing wikiId-error contrastive example, deliberately
// distinguishing the two cases (unknown domain vs. known-but-wrong domain)
// the way §3 of interpreting-results.md recommends, since an abstract
// "follow tool corrections" restatement wouldn't disambiguate which
// concrete action (locate vs. direct retry) applies. Re-run all three
// models against wwrite-006 through wwrite-009 next round to check it
// closes the gap; wwrite-002's known ornith/Lemonade dry-run-vs-prose
// ceiling (see suite comments) and local's raw-JSON/tool-call-parsing
// failures on wwrite-001/004 are unrelated to this fix and were not
// targeted by it — see this round's auto-eval log for that diagnosis.
//
// Fifteenth entry, issue #155 (2026-09-08). wnav-009's collapse (models
// dropping the "this was originally a multi-candidate tie" state across
// turns and skipping the required wiki_orient detour — nine-plus
// consecutive identical failures on ornith, a confirmed ceiling per the
// eleventh/thirteenth entries) turned out to be a tool-surface gap, not a
// wording gap: wiki_search had no way to scope itself to one domain, so the
// prompt's own workaround ("wiki_orient on that domain is what actually
// confines you to it") was asserting something no tool call actually did.
// wiki_search now takes an optional wikiId (wiki-search.tool.ts) that
// filters the search to one domain when passed. Rewrote the two paragraphs
// below that described the old wiki_orient-as-confinement workaround and
// the "concrete test" for detecting the multi-candidate case — there's
// nothing stateful left to detect: wikiId travels with wiki_search
// (or wiki_orient) the same way regardless of how the domain was resolved.
// Re-run wnav-009 (rewritten to expect a scoped wiki_search call — see
// suites/wiki-navigation.yaml) next round to confirm the ceiling is closed.
//
// Sixteenth entry, first auto-eval round against the fifteenth entry's
// wording (2026-09-08, local/Lemonade/Ornith/Digital Ocean, judge local).
// Confirmed the ceiling closed for ornith: wnav-009 passed (15/15, no
// failures at all) after nine-plus consecutive collapses pre-fix. local
// and Digital Ocean also passed wnav-009 and the new wnav-013 (single-match
// scoped search, same issue #155 addition) cleanly. Lemonade failed both,
// in a new shape distinct from ornith's old collapse: calledTools:
// [wiki_orient] on each, with reasoning that correctly identified the
// resolved domain ("the wikiId confirms... 'user'") but then inserted a
// wiki_orient call anyway before searching — old wiki_orient-first habit,
// not the multi-candidate-collapse shape this section's abstract wikiId
// paragraph was written to fix. Per interpreting-results.md §3, an abstract
// rule ("no separate confinement step required") had no worked example to
// anchor to; added one contrasting wnav-009's narrowed-tie phrasing and
// wnav-013's single-match phrasing, both landing on wiki_search directly,
// with an explicit reason wiki_orient is redundant here. wnav-004 also
// failed for Lemonade again, in the exact prose-instead-of-ask_user shape
// the eleventh entry already confirmed as a ceiling — left alone, not
// re-chased. Re-run Lemonade against wnav-009/wnav-013 next round to check
// the new example lands; if it reproduces in the same wiki_orient-first
// shape with wording unchanged, that's evidence of a second Lemonade-
// specific ceiling, not a remaining wording gap.
//
// Seventeenth entry, issue #186 (2026-09-14). Not a wording tightening like
// entries one through sixteen — those all reacted to a specific failure
// shape with a targeted sentence or example. This one is structural.
// PR #184's follow-up measurement comment (7 identical-condition samples
// per scenario, rounds 4-10 of that suite's auto-eval loop) confirmed
// Lemonade's flakiness on suites/explicit-tool-syntax.yaml's baseline,
// no-directive scenarios (ets-002/ets-004 — the same default domain-routing
// behavior wnav-001/007/008/009/013 exercise here) is genuine sampling
// variance, not a reachable wording gap: 4/7 pass on both, failures
// scattered across different rounds with no common reasoning-shape cause.
// The usual fix pattern this section has used 16 times — add a contrastive
// example anchoring the specific failure — doesn't apply when there's no
// single failure shape to anchor against.
// Full design: docs/superpowers/specs/
// 2026-09-14-wiki-navigation-section-restructure-design.md. Rewrote the
// section from ~13 flowing prose paragraphs into a numbered decision
// procedure (resolve domain -> resolve wiki_locate's result -> act on the
// resolved wikiId -> priority overrides), on the hypothesis — drawn from
// PR #184's own diagnosis of a related ceiling ("a structural fix... is
// more likely to move it than another paragraph edit") — that less content
// competing for attention, laid out as an explicit checklist, is more
// resistant to sampling variance than the same substance spread across
// narrative paragraphs. Every rule and worked example from entries 1-16
// is preserved (verified against the specific eval scenario each protects
// — see the design doc's rule-inventory table); nothing new was added,
// nothing was cut for length. No local model server is reachable from the
// environment this change was authored in, so none of this has been
// re-run yet. Next real eval run should: (1) regression-check every
// previously-passing suites/wiki-navigation.yaml scenario, since a
// structural rewrite risks touching rules that already work even without
// changing their substance; (2) re-measure Lemonade's ets-002/ets-004 pass
// rate against this entry's 4/7 baseline once suites/explicit-tool-
// syntax.yaml is available locally (PR #184 is unmerged as of this entry).
// If the pass rate doesn't move, that's evidence the density hypothesis
// itself doesn't hold for this model/section — not a cue to keep chasing
// this with further wording edits, per interpreting-results.md §5.
//
// Eighteenth entry, fresh auto-eval round against the seventeenth entry's
// restructure (2026-09-14, Ornith/Lemonade/local, judge local). ets-002/
// ets-004 (the density hypothesis's target) held for both Ornith and
// Lemonade this round — encouraging, though one round isn't enough to
// confirm the 4/7 Lemonade flakiness is actually resolved. But a different,
// previously-fixed scenario broke for BOTH models: ets-001
// (directive-overrides-default-routing), where a #wiki_search token is
// present. Both models' reasoningContent walked straight into the domain-
// routing procedure and called wiki_locate first, never once citing the
// directive or notation's override rule — Lemonade's trace even opened by
// correctly stating "explicitly invoking the wiki_search tool" and then
// talked itself into wiki_locate anyway. Root cause: the design doc's
// rule-inventory table captured entries 1-16 (all reactions to
// suites/wiki-navigation.yaml failures) but not the directive-precedence
// gate a *different* auto-eval session (suites/explicit-tool-syntax.yaml,
// rounds 2-3, commits ff9edbe/93decd4) had added to the old prose — that
// fix predates this restructure's design doc and was never folded in, so
// the rewritten step 4 ("Priority overrides") covers tool-result changes
// and write-rejection retries but never mentions a `<required-tool>`
// instruction at all. Also applying round 3's structural lesson from that
// same prior session: a gate stated only in step 4, after the routing
// steps, loses to top-to-bottom reasoning that's already committed to a
// domain-routing chain of thought by the time it gets there. Added a
// leading paragraph before step 1 stating the gate up front, rather than
// appending a bullet to step 4. Re-run Ornith and Lemonade against ets-001
// next round to confirm the gate holds now that it's back and positioned
// first.
//
// Nineteenth entry, fresh auto-eval round against the eighteenth entry's
// restored directive gate (2026-09-14, Ornith/Lemonade/local, judge local).
// The gate itself is genuinely working now — Ornith passed ets-001 cleanly
// this round — but Lemonade failed it again, in the same shape entry
// seventeen's own restructure comment already described (named the
// directive correctly, then reasoned through the numbered steps anyway and
// landed on wiki_locate). One sample isn't enough after a wording change to
// call this a ceiling per interpreting-results.md §5 — no code change here,
// re-run next round to see if it recurs under unchanged wording before
// touching this again.
//
// The same round surfaced a second, separate, and more clear-cut gap:
// Ornith failed ets-004 (#not_a_real_tool, no real directive — falls back to
// the plain no-directive default) while passing the identical underlying
// question in ets-002. That inconsistency is explained by a real regression
// entry seventeen's restructure introduced: the "favorite programming
// language is NOT domain-exclusive the way favorite color is" contrastive
// example — proven out over rounds 1-3 of the *original*
// suites/explicit-tool-syntax.yaml auto-eval session (commits e75a104/
// ff9edbe/93decd4, well before PR #186) — never made it into the rewritten
// decision procedure. The seventeenth entry's restructure comment says its
// rule-inventory table covered entries 1-16 (all wiki-navigation.yaml
// failures); this fix came from a *different* suite's session and was
// missed the same way the directive gate itself was (see the eighteenth
// entry). Restored it as a terse contrastive example in step 1's list,
// matching this section's new decision-procedure style rather than
// reproducing the old prose paragraph verbatim. Re-run Ornith and Lemonade
// against ets-002/ets-004 next round to confirm this closes the gap the way
// it did the first time.
//
// Twentieth entry, re-run against the nineteenth entry's fix (2026-09-14,
// Ornith/Lemonade/local, judge local). ets-002/ets-004 held for both models
// (4/4 combined across two rounds now) — the restored example closed that
// gap. But ets-001 failed for BOTH models this round, in a shape distinct
// from every previous ets-001 failure this section's history has seen:
// both explicitly identified the `<required-tool id="wiki_search">`
// instruction in their reasoning (Ornith's trace even quotes it verbatim
// and states "This means I should use wiki_search directly"), then talked
// themselves out of calling it because they believed wiki_search needed a
// wikiId they didn't have yet, and called wiki_locate first to obtain one.
// Root cause: the gate paragraph says to call the required tool "directly
// with whatever arguments the request implies," but never states that
// wiki_search's wikiId is optional and that omitting it (searching across
// every domain, per its own tool-list line above) is a valid way to
// satisfy "whatever arguments the request implies" when no domain is
// already known — so the model filled that gap with its own assumption
// that an argument was missing, and treated the steps below as the
// prerequisite for producing it. This is a materially different failure
// from the eighteenth/nineteenth entries' "ignored the gate" shape, so not
// treating it as a recurrence of an already-ceiling-flagged issue — it's
// a new, well-understood gap with an obvious fix. Added one sentence to
// the gate paragraph closing this specific loophole, with wiki_search
// named concretely (the only currently-required-able wiki tool this
// section's own suite exercises without a prerequisite argument). Re-run
// Ornith and Lemonade against ets-001 next round to confirm.
//
// Twenty-first entry, 2026-09-15. Not from a fresh auto-eval run in this
// environment (no local model server is reachable here) — from a
// read-through diagnosis after PR #187's own 20-round consistency check
// (posted as a PR comment) showed the eighteenth-twentieth entries' fixes
// hadn't moved ets-001's aggregate pass rate (Lemonade 10/20, Ornith 6/20,
// no streak pattern across rounds). Root cause: the nineteenth entry
// restored the "favorite programming language" contrastive example's
// content but not the "this is the no-directive default" qualifier the
// *original* fix for this exact collision had, back when it first appeared
// in the pre-restructure prose (suites/explicit-tool-syntax.yaml auto-eval
// session, commits ff9edbe/93decd4, well before PR #186). ets-001's own
// input is that literal phrase prefixed with #wiki_search — so the
// unqualified restored example was anchoring the model toward wiki_locate
// for ets-001's own input, competing directly with the leading directive
// gate stated several lines earlier. Per interpreting-results.md §3
// (contrastive examples anchor harder than abstract rules), an abstract
// gate stated once, upstream of a concrete matching example, is exactly the
// shape that loses. Added a second, narrower contrastive clause directly to
// that example bullet, showing the same phrase with a directive landing on
// wiki_search — the same fix pattern that closed this identical collision
// the first time it appeared. Not yet validated here; needs a fresh
// multi-round check against ets-001 specifically (not a single re-run) per
// the PR's own consistency-check finding that single/double-round passes on
// this scenario aren't distinguishable from its ~30-50% baseline noise.
//
// Twenty-second entry, 2026-09-15. Not from a fresh auto-eval run in this
// environment (no local model server is reachable here) — from a
// read-through diagnosis after a 20-round suites/wiki-navigation.yaml
// regression check (posted as a PR #187 comment) against the twenty-first
// entry's wording, run because every prior validation of this suite since
// the restructure had been 1-2 rounds at most. Two real regressions
// surfaced, both traced to content this section already carried getting
// compressed or crowded during the restructure rather than to anything new:
//
// 1. wnav-008 ("What's my favorite color?" should skip straight to
// wiki_search) failed 80-95% of rounds across all three models (local
// 19/20, Ornith 16/20, Lemonade 19/20) — a cross-model near-universal
// failure on a scenario that had been reliable since the third tightening
// entry, which per interpreting-results.md §5's cross-check is the
// signature of a shared prompt problem, not three coincident model
// ceilings. Root cause: step 1's Examples list had grown to one skip case
// immediately followed by four "looks similar, but call wiki_locate
// anyway" cases in a row using near-identical phrasing ("not
// domain-exclusive," "same ambiguity as..."), including the
// favorite-programming-language example the twenty-first entry just made
// longer. Nothing marked these as two different categories — a model
// reading top-to-bottom hits one short "skip" line and then a wall of
// "actually, don't skip" reasoning reinforced four times right after it.
// Split the flat list into two explicitly labeled groups ("skip
// wiki_locate" vs. "call wiki_locate (looks similar, but isn't")) so the
// categorization is structural rather than something to infer from prose
// similarity. No content removed or added, only regrouped.
//
// 2. wnav-004 (a reported tie should go to ask_user, never decided by
// feel) jumped to a 12/20 miss rate for Ornith — previously only ever
// logged as occasional variance for this model, never a pattern (see the
// ninth/eleventh entries). This is, by this file's own history, the single
// hardest rule to get a model to reliably follow: it took two full
// emphatic paragraphs in the pre-restructure prose, with "a reported tie is
// a tie even if one candidate feels more plausible to you" stated as its
// own standalone sentence, and even then Lemonade never fully cleared it —
// a confirmed, accepted ceiling (eleventh entry), not a wording gap. The
// restructure compressed both paragraphs into one bullet and demoted that
// same claim to a trailing subordinate clause. A rule that needed more
// reinforcement than anything else in this file just to reach "ceiling,
// not gap" is exactly the one most likely to suffer from under-reinforcing
// during a density-reduction pass. Restructured the bullet so "a tie stays
// a tie regardless of feeling" and "ask_user is the only correct move" are
// each their own leading sentence again, same content, reordered for
// emphasis — matching the shape that worked before the restructure.
//
// Both fixes are independent, non-overlapping edits (different bullets, no
// interaction risk). Not yet validated in this environment; needs a fresh
// 20-round suites/wiki-navigation.yaml run against all three models to
// confirm wnav-008 recovers and to see whether Ornith's wnav-004 rate drops
// back toward the "occasional variance" it was before — full recovery to
// 0/20 isn't the bar, since some prior variance on this rule for Ornith,
// and Lemonade's confirmed ceiling on it, both predate this restructure
// entirely and aren't this round's problem to solve.
//
// Twenty-third entry, 2026-09-15. The twenty-second entry's confirmation run
// landed as a PR #187 comment: wnav-008 recovered as predicted (local
// 19/20→7/20, Ornith 16/20→7/20, Lemonade 19/20→12/20 failures), but
// wnav-004 barely moved (Lemonade 20/20→17/20, Ornith 12/20→11/20) — the
// wording change did not do what it was written to do. Four raw
// reasoningContent traces (2 Lemonade, 2 Ornith; one before- and one
// after-fix round each, user-supplied since eval logs aren't reachable from
// this environment) were read directly rather than inferring cause from the
// pass-rate delta alone, per interpreting-results.md §5. None showed the
// targeted failure shape (reasoning correctly identifies the tie, then talks
// itself into a hunch anyway). Instead: three of four traces (both Lemonade
// rounds, one Ornith round) show reasoningContent correctly naming ask_user
// as the right call, followed by no tool call at all — calledTools: [],
// finish_reason: stop, prose output instead. The fourth (Ornith, post-fix)
// skips tie-break reasoning entirely by hallucinating a candidate domain
// name ("training-fitness") that was never seeded, then calling
// wiki_read_page against it. Both are tool-invocation follow-through
// failures, not reasoning failures this section's wording can reach —
// there's no misjudgment in the transcript to correct with clearer prose.
// This matches the eleventh entry's "confirmed ceiling" finding for
// Lemonade and extends it: for both models, on this specific rule, the
// bottleneck now looks like execution reliability (emitting the tool call
// the model's own reasoning already committed to), not rule comprehension.
// The wording change from the twenty-second entry is left in place — it's
// harmless and correctly reordered emphasis that matches the
// pre-restructure shape — but it should not be iterated on further as a fix
// for wnav-004; doing so would be re-tightening a rule the traces show is
// already being followed in reasoning and failing downstream of it. A real
// fix, if pursued, is a harness-level change (e.g. detecting a
// reasoning-committed-but-no-tool-call turn and forcing a retry, or a
// stricter tool_choice constraint) — out of scope for this file and not
// something to build speculatively without a separate decision to pursue
// it.
const WIKI_NAVIGATION_SECTION = `You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content, across every domain by default or scoped to one via wikiId.
- wiki_read_page: read a specific page's full content once you've found it.

Follow this procedure in order — each step only applies when the step before it didn't already
resolve things.

A \`<required-tool>\` instruction already resolved which tool to use this turn (see notation) —
call it directly with whatever arguments the request implies, skipping every step below. The
steps below are how you resolve the tool and its arguments when no such instruction is present;
they're not a checklist to run through regardless, and a topic that would otherwise call for
wiki_locate doesn't override a directive that already answered the question. This includes a
required wiki_search with no domain already known: wikiId is optional and wiki_search already
searches across every domain when it's omitted, so call it without one rather than calling
wiki_locate first to produce a wikiId the directive never asked for.

1. Resolve the domain.
   - The domain was already established earlier in this conversation → it's known; skip to step 2.
   - The question is itself about where to look ("which part of the knowledge base should I
     check?") → call wiki_locate. Sounding personal doesn't exempt this — a question about
     routing is not a question about the fact itself.
   - The topic names something so specific to the user's own stated preferences that no other
     domain could plausibly cover it → skip wiki_locate; the domain is known, go to step 2.
   - Anything else — a topic that merely sounds personal or plausible without being
     domain-exclusive, or a technical/setup topic even phrased possessively ("my X") — call
     wiki_locate. "My" says whose thing it is, not which domain documents it.

   Examples — skip wiki_locate (no other domain could plausibly cover it):
   - "What's my favorite color?" → wiki_search directly (nothing but the user's own preferences
     could ever answer this).

   Examples — call wiki_locate (looks similar, but isn't actually domain-exclusive):
   - "What is my favorite programming language?" → wiki_locate (could belong to a
     technical/engineering domain instead of personal preferences — not domain-exclusive the way
     color is, same ambiguity as the Verdaccio example below). This is the no-directive default:
     "#wiki_search What is my favorite programming language?" → wiki_search directly instead —
     the required-tool gate above already decided it, so this ambiguity doesn't apply.
   - "What have you noticed about growth lately?" → wiki_locate (could be the user's growth or
     your own reflective growth — genuinely ambiguous).
   - "Which part of the knowledge base should I check for my personal preferences?" → wiki_locate
     (asking for routing outright, despite mentioning "personal preferences").
   - "What was the process for generating a new NPM token for Verdaccio?" and "I need to generate
     a new NPM token for my Verdaccio instance" → wiki_locate either way (a technical/setup topic
     could belong to a dedicated technical domain just as easily as personal notes; the possessive
     phrasing in the second one doesn't change that).

2. Resolve wiki_locate's result (skip if step 1 already gave you a known domain).
   - No match → stop trying to route further; say plainly that nothing in the wiki covers this
     rather than answering from an unrelated domain.
   - One outright match → that wikiId is resolved; go to step 3.
   - Multiple candidates (a tie) → a tie stays a tie even when one candidate feels more plausible
     to you; that feeling is not real information, and proceeding on it — or announcing your pick
     in your reply — is the same mistake as inventing a narrower context. Narrow to one only using
     something real: the routing notes attributing the request to a single candidate, or something
     the user actually said elsewhere in the conversation. Don't invent a narrower context to retry
     wiki_locate with. If nothing real breaks the tie, call ask_user and ask which domain they
     mean — that's the only correct move, not deciding for them. Once narrowed, go to step 3.

3. Act on the resolved wikiId.
   - Overview request ("what do we already know about this?", "what's in the knowledge base
     here?") → wiki_orient({ wikiId }), even on a single outright match — an overview needs the
     page index, which only wiki_orient returns.
   - Concrete question with something specific to search for → wiki_search({ wikiId, query })
     directly, whether wikiId came from an outright match or from narrowing a tie. Don't detour
     through wiki_orient first: only wikiId confines the search, and orient adds nothing a direct
     scoped search doesn't already give you. Omit wikiId only when you deliberately want to search
     across every domain at once.
   - Already know exactly which page? → wiki_read_page it directly rather than re-searching.
   - Add or save a fact, and nothing already on-topic turned up (from wiki_orient's index, or
     because the domain was already established) → wiki_create_page directly, picking a sensible
     title yourself. Don't run a wiki_search first to check whether a page already exists —
     wiki_create_page detects near-duplicates itself — and don't ask where to put it; the request
     to add the note was already the decision.

   Examples:
   - "What have I told you I prefer for my morning routine?" (wikiId narrowed from a tie) →
     wiki_search({ wikiId, query }) — a concrete fact, not an overview.
   - "What programming languages do I use most at work?" (wikiId from a single outright match) →
     wiki_search({ wikiId, query }) — same reasoning; how the wikiId was resolved doesn't matter.
   - "What do we already know here?" → wiki_orient({ wikiId }), even on a single outright match.

4. Priority overrides — these outrank every default above.
   - A tool's own result is more current than this guidance. An error or explicit instruction from
     a call — an unrecognized wikiId telling you to call wiki_locate, for example — wins over
     whatever step you'd otherwise skip.
   - A write rejection that already names the correct wiki (wiki_create_page, wiki_update_page,
     wiki_add_cross_link, or wiki_rebaseline_source refusing the wiki you tried and naming the one
     you're allowed to write to) is a different case from an unrecognized wikiId: the domain is
     already known, just not the one you used. When the user's next turn confirms to proceed —
     "use the right one," "try that again," a plain "yes" — retry the exact same call with only
     wikiId swapped to the one the rejection named. Don't re-derive the path, content,
     fromPage/toPage, or rawFilePath you already had, and don't ask what they'd like to do next;
     the confirmation already answered that.`;

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
// 8. wfetch-003, auto-eval round 2 of suites/web-fetch.yaml (2026-08-26):
//    with the scenario's stale argCheck fixed (see suites/web-fetch.yaml's
//    own comment — it was checking a `content` path the tool schema never
//    had), local's actual behavior became visible for the first time:
//    round 1 fabricated a threadId/toolKey pair for a plain, non-offloaded
//    fetch (there was never a stub to copy those from), round 2 passed
//    corpus as a bare string. Root cause: this section's only concrete
//    corpus example was the compact-stub's `{ threadId, toolKey }` shape —
//    the direct-write path this section is mostly about had no example of
//    its own `{ raw }` shape to anchor on, so local guessed twice and
//    missed twice. glm and Ornith got the shape right from the tool's zod
//    schema alone both rounds, so this wasn't flagged as a ceiling — it's
//    the classic missing-contrastive-example gap (interpreting-results.md
//    §3), just on a tool-call argument shape instead of a routing choice.
//    Added the missing inline-corpus example right where the direct-write
//    instruction already lives. Re-check local's wfetch-003 next round; if
//    it still misses in a new third shape, that's the plateau signature.
// 9. Auto-eval round 1 of the new suites/get-tool-key.yaml (2026-09-07),
//    the first run since get_tool_key itself shipped. Ornith and Lemonade
//    each failed one of the five scenarios; local and a new Digital Ocean
//    provider passed all five, so per the §5 cross-check these read as
//    two separate model-specific gaps rather than a shared prompt problem
//    — but both had a plausible, fixable wording cause, so both got one:
//    (a) GTK-004a (Ornith): asked to save a stub whose ingest block still
//    carried the literal `<page title>` placeholder, Ornith called
//    get_tool_key first, reasoning "I need to get the full title from the
//    offloaded content first." Nothing here said the placeholder was the
//    model's own job to fill in from the summary — Lemonade, local, and
//    Digital Ocean all inferred a title correctly without being told to,
//    so this was a real gap, not a shared ambiguity. Added a paragraph
//    right after the ingest-block instruction naming the placeholder as a
//    naming task, not a retrieval one.
//    (b) GTK-001 (Lemonade): given a plain offloaded stub with no ingest
//    block at all, asked for a quoted detail, Lemonade's own reasoning
//    claimed the stub "includes an explicit block with a threadId and
//    toolKey for ingesting the full content into the wiki" — a block that
//    was never in that scenario's seed — and called wiki_create_page
//    instead of get_tool_key. This looks like the model pattern-matching
//    the stub format itself onto the ingest-block shape rather than
//    checking whether that literal heading was actually present; the
//    other three models read the same stub correctly. Added a contrastive
//    paragraph stating plainly that a stub without that literal heading
//    never carries the instruction, regardless of what similar stubs look
//    like elsewhere, and that a request for more detail than the summary
//    gives always resolves through get_tool_key. Re-check both scenarios
//    against Ornith and Lemonade next round; if either misses again in the
//    same shape, that's the plateau signature for that model.
const WEB_FETCH_SECTION = `web_fetch retrieves a URL's content — the page text, metadata, links, and outline.

When the user asks you to save, add, or ingest a URL into the wiki, call web_fetch first, before any
wiki tool. Routing needs the content: you can't judge which domain a page belongs in from its URL
alone, so calling wiki_locate before fetching just orders the steps backwards. Fetch, then route,
then write.

Some web_fetch results are compact stubs — the full content was too large to include inline and is
stored externally. A stub is recognisable by its opening line:

  ── CONTENT OFFLOADED ──────────────────

It contains a short summary, key concepts, and metadata (tool, chars, key, threadId).

Reach for get_tool_key when you need the offloaded text for anything else — answering a question in
more detail than the stub's summary gives you, quoting a passage, or working with the full document
yourself. Call it with the same threadId and toolKey shown in the stub, copied verbatim. get_tool_key
only works with a real key from an actual stub already in this conversation — never invent a
threadId or toolKey to try it speculatively; if there's no stub, the content you have is already
everything there is.

If a stub's summary points at a "to ingest into wiki:" workflow but you don't have wiki write access
in your current toolset, don't try to satisfy it — not by calling anything under a guessed title, and
not by asking the user for missing details like a title. Present the stub's summary and key concepts
as your answer instead, and say plainly that you don't currently have write access to store it.`;

// Split out of WEB_FETCH_SECTION (issue #154) — this content only makes sense
// when wiki_create_page is actually bound; see filterHarnessSections() below
// and docs/superpowers/specs/2026-09-13-tool-scoped-system-prompt-sections-design.md.
// Requires BOTH web_fetch and wiki_create_page (not just wiki_create_page):
// every paragraph here is about combining a web_fetch result with a wiki
// write, so it's meaningless on its own if fetching isn't even bound.
const WIKI_INGEST_SECTION = `The reverse applies once the content is already in hand. If a web_fetch already succeeded in this
conversation and the user asks you to save what it returned, that request is the decision — proceed
to the write. When a wiki_locate result has already established the domain, call wiki_create_page
directly with the fetched content, passing it as an inline corpus:

  wiki_create_page({
    wikiId: "engineering",
    title:  "Vector Databases — Concepts",
    corpus: { raw: "<the fetched page text, as markdown>" },
    section: "concept"
  })

corpus.raw takes the content itself, as a string — not a threadId/toolKey pair (that shape is only
for the compact-stub case below, where the tool fetches the body itself from a key you don't have the
text for) and not the content passed under some other field name. wiki_create_page itself detects
near-duplicate pages and points you to wiki_update_page instead, so you don't need a wiki_orient pass
first just to check whether the page already exists. Asking where to save it or whether to summarize
first, when the user has already said "save it," is the confirmation round-trip ask_user_routing tells
you not to make.
Placement isn't a reason to orient first either — wiki_create_page derives the new page's path
itself from the wikiId, title, and section you pass, so orienting "to find the right spot" for a
page you're about to create adds a round-trip for nothing. With a fetched recipe in hand and a
wiki_locate result naming "cooking" as its domain, the very next call is wiki_create_page — not a
wiki_orient pass to "see the domain's structure" first. wiki_locate's result may itself point at
wiki_orient as a possible next step — that is a generic browsing pointer, not an error or a
correction, so it doesn't override this direct-write path the way a real error result would.

When a compact stub (see web_fetch above) includes a "to ingest into wiki:" block like this:

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

The block's own title field is usually a placeholder — <page title> — for you to fill in, not a
value already decided. Pick a short, descriptive title straight from the stub's summary and key
concepts; needing a title is never a reason to call get_tool_key first, even when the summary feels
too brief to name it confidently. That placeholder is an invitation to name the page from what
you already have, not a missing prerequisite that requires fetching the full text.

That reference is for the wiki path specifically — do not resolve it yourself first with
get_tool_key just to hand the text to wiki_create_page as corpus.raw; pass the
corpus:{threadId, toolKey} reference straight through instead.

A stub without that literal "to ingest into wiki:" heading never carries the instruction above,
no matter how similar it looks to one that does — check the stub's own text for that heading
before acting on it, rather than assuming it based on other stubs you've seen in this conversation
or in these instructions. A plain stub (summary and key concepts only) paired with a request for
more than the summary gives — the exact wording, a specific detail, the full document — is a
get_tool_key case, not a reason to invent an ingest block that was never actually there.`;

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
//
// Extended for suites/explicit-tool-syntax.yaml's ets-001, round 3 of a
// 2026-09-14 auto-eval session (Ornith/Lemonade/local, judge local).
// WIKI_NAVIGATION_SECTION's own directive-override gate (see its twentieth
// entry) was holding on its own terms but ets-001 kept failing anyway —
// Lemonade's reasoning traced the exact mechanism directly: it read this
// section's "Reach for wiki_locate before responding" as a complete,
// self-sufficient instruction, treating the pointer to wiki_navigation as
// only covering *when it's safe to skip* wiki_locate, not whether a
// `<required-tool>` directive could override the default outright — so a
// #wiki_search directive got "noted" and then set aside as secondary to
// this sentence's own imperative. This section is read before
// wiki_navigation's gate, so a model that treats it as sufficient on its
// own never reaches the correction downstream. Added the same override
// clause here, at the point where the competing imperative actually lives,
// rather than relying on a model reading far enough ahead to find it. Not
// yet re-tested against Ornith's own round-3 failure (a different shape —
// no mention of the directive at all — that may be independent flakiness
// rather than this same mechanism). Re-run both models against ets-001
// next round.
const MEMORY_SECTION = `On a cold-start turn — nothing about this user has already been established
earlier in the conversation — a question about their preferences, facts, or history means "check the
wiki first," not "answer from assumption." Reach for wiki_locate before responding, unless a
\`<required-tool>\` instruction (see notation) already named a different tool to call this turn — that
directive is the decision, not a secondary consideration to weigh against this default. Otherwise see
wiki_navigation for exactly when it's safe to skip straight to wiki_search instead. If the wiki genuinely has nothing on the topic, say so
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

// Documents both message-prefix notations the user may write, so the model
// recognizes them without having to infer their meaning from context alone.
// `/skill-name` already exists (skill-expansion.middleware.ts); `#tool-name`
// is new (issue #172) — tool-syntax.middleware.ts detects it and
// tool-access.middleware.ts turns a matched, currently-bound tool into a
// <required-tool id="..."> instruction appended to this same system message.
// An unmatched or currently-unavailable #name produces no instruction at
// all — the last sentence exists so the model doesn't go looking for one or
// comment on its absence when a user's message happens to contain a bare #.
//
// Second entry, fresh auto-eval round against suites/explicit-tool-syntax.yaml
// (2026-09-16, local/Lemonade/Ornith, judge local; log
// eval-logs/auto-eval-20260915211428.yaml). Lemonade and Ornith both passed
// 4/4; local alone failed ets-004 (#not_a_real_tool, an unmatched token) at
// 3/4. local's own reasoningContent stated the unmatched-token rule
// correctly almost verbatim ("the #something doesn't match a tool
// currently available, we proceed normally") and then didn't follow
// through — it treated "proceed normally" as license to pick whichever
// tool seemed related (wiki_search) rather than actually re-running the
// same procedure the identical question (minus the token) correctly
// produced wiki_locate for in ets-002 moments earlier in the same run. Per
// interpreting-results.md §5 this is the "states the correct rule, doesn't
// follow through" ceiling shape, but this is the first round against this
// exact wording for this scenario/model pair, so treating it as a wording
// gap rather than an established ceiling. Per interpreting-results.md §3,
// the abstract "using your own judgment" phrasing gives a smaller model
// nothing concrete to anchor the word "normally" to; added a worked
// example, using this suite's own scenario input, showing the unmatched
// case resolving identically to the bare no-directive case. Re-run local
// against ets-004 next round to confirm.
const NOTATION_SECTION = `Two prefixes carry special meaning when they appear in a user's message:

- \`/skill-name\` invokes a skill — its instructions replace or extend the message content for this turn.
- \`#tool-name\` marks a tool the user is explicitly requiring for this request. When a matching tool is
currently available to you, you will also see a \`<required-tool id="tool-name">\` instruction elsewhere in
this system message — treat that as a directive overriding your own default tool choice, not as a
suggestion to weigh against other options.

Both prefixes only take effect through the mechanism above — a \`<required-tool>\` instruction is either
present or it isn't. If a message contains \`#something\` but no matching \`<required-tool>\` instruction
appears, the name didn't match any tool currently available to you (a typo, or a real tool that's
disabled right now); this needs no reaction from you — proceed with the request normally, using your own
judgment for tool selection as you would if the \`#\` text weren't there. That means actually re-running
the same tool-selection procedure (see wiki_navigation) the request would get without any \`#\` text at
all, not treating the unmatched name as a shortcut to whichever tool sounds related. For example,
"#not_a_real_tool What is my favorite programming language?" resolves exactly like the bare question
"What is my favorite programming language?" would on its own — wiki_locate first, per wiki_navigation's
own no-directive default — not a direct wiki_search just because a tool-shaped token appeared in the
message.`;

// Motivated by auto-eval round 1 of suites/tool-calling.yaml (2026-09-22,
// local/Lemonade/Ornith/Digital Ocean, judge local). No section anywhere in
// this file mentioned upload_image or any image-producing tool before this
// one — tools-002-comfyui-then-upload (a prior tool call already returned
// imageBase64/mimeType; the correct next step is upload_image with those
// exact values) failed for local (embedded the raw base64 directly as a
// markdown data URI, calledTools: []) and Lemonade (refused outright,
// reasoning that the seeded bytes "looked like a placeholder" and it
// "should inform the user honestly instead," calledTools: []) while
// stronger models (Ornith, Digital Ocean) inferred the right handoff purely
// from the tools' own descriptions/schemas. Per interpreting-results.md §3,
// added a worked example matching this suite's own scenario shape (a prior
// tool call's result already contains imageBase64/mimeType) rather than
// just stating the rule abstractly. Left Lemonade's specific "this base64
// looks fake" suspicion unaddressed — telling models to distrust their own
// pattern-matching on tool results is a much broader, riskier prompt change
// than this one gap justifies; re-evaluate only if it recurs.
const IMAGE_SECTION = `upload_image is the only way to make an image actually appear in your response — it takes raw base64
image bytes and a MIME type and returns a real Markdown image link. Generating or otherwise
producing image bytes does not display anything by itself; the bytes only become a visible image
once you hand them to upload_image.

If an earlier tool call in this conversation already returned image bytes — a result containing
something like imageBase64 and mimeType — call upload_image next, passing those exact values
verbatim. Don't embed the base64 yourself as a markdown data URI, don't invent a link, and don't
second-guess the bytes as fake or a placeholder and decline instead: treat a prior tool's result as
real and act on it, the same way you would trust any other tool's output. For example, a prior
generate_image call that returned { imageBase64: "...", mimeType: "image/png" } is followed by
upload_image({ imageBase64: "...", mimeType: "image/png" }) — copying both fields across unchanged,
not re-describing or omitting either one.

If you don't yet have image bytes at all, produce them first with whatever image-generating tool is
available, then follow up with upload_image once that call returns — the two steps happen in order,
not as one call.`;

// Motivated by auto-eval round 2 of suites/tool-calling.yaml (2026-09-22,
// Lemonade/Digital Ocean, judge local, after round 1's evalTools fix made
// search_skills reachable at all — see IMAGE_SECTION's neighboring entry for
// that history). Both models correctly called search_skills for
// tools-004-search-skills-keyword ("Do you have any skills for summarizing
// content?") but passed no keyword — Lemonade's reasoning explicitly chose
// to "list all skills, then see if any are related to summarizing" instead
// of narrowing the call itself. No section anywhere in this file mentioned
// search_skills before this one, so the tool's own schema description
// ("Call with no argument to list all skills") was the model's only
// guidance, and it says nothing about the keyword-narrowing case. Added a
// worked contrastive pair straight from this suite's own two scenarios
// (tools-003's bare "what skills do you have" vs. tools-004's topic-named
// "skills for summarizing") per interpreting-results.md §3.
const SEARCH_SKILLS_SECTION = `search_skills looks up installed skills by name, description, or slash command. When the user's
question names a specific topic or task — "do you have anything for summarizing content?", "any
skills for X?" — pass that topic as the keyword argument so the search itself narrows the results,
rather than calling it with no argument and filtering the full list yourself afterward. Reserve the
no-argument call for when the user asks broadly, without naming a topic — "what skills do you have
available?", "what can you do?" — where there's nothing yet to narrow by.`;

// Motivated by auto-eval round 1 of suites/task-creation.yaml (2026-09-22,
// local/Lemonade/Ornith/Digital Ocean, judge local), run right after
// bin/eval.ts's evalTools gained create_tasks (it was missing entirely,
// same class of gap as SEARCH_SKILLS_SECTION's neighboring entry — see
// bin/eval.ts's own comment on that addition). With the tool actually
// reachable, three of the four models (local, Lemonade, Digital Ocean)
// correctly called create_tasks for tc-002-tracker-url-passed-not-retyped
// but left trackerUrl blank or empty despite the GitHub issue URL already
// sitting in the conversation from an earlier web_fetch — local's own
// reasoningContent even concluded "No tracker URL? Probably none" right
// after restating the fetched issue's content. Ornith, the one model that
// already threaded the URL through correctly, was inferring it purely from
// the tool's own schema description. No section anywhere in this file
// mentioned create_tasks before this one. Added a worked example matching
// tc-002's own scenario shape (a prior web_fetch of a specific issue URL,
// followed by approval) per interpreting-results.md §3, and restated the
// tool's own "only after approval, not mid-brainstorm" restraint explicitly
// here too — tc-001-no-premature-creation currently passes only because no
// section discusses create_tasks at all, and documenting the tool without
// repeating that restraint risked teaching models to reach for it earlier
// than intended.
//
// Round 2 (same suite, same providers, run right after the fix above):
// local and Digital Ocean now pass cleanly. Lemonade and Ornith regressed
// on tc-002 specifically — both moved from "called create_tasks with a
// missing field" (round 1's failure) to not calling it at all, second-
// guessing whether the user's "yes, let's go with that plan" really
// authorized action: Lemonade asked the user to confirm scope before
// queuing anything ("I'm asking you to confirm how to name and scope each
// task"), and Ornith doubted whether the fetched issue was even "the plan"
// being referenced at all ("this doesn't seem to be what the user was
// referring to... I don't have any record of discussing a plan with
// them") despite that plan sitting right there in priorTurns. This reads as
// the over-generalization interpreting-results.md §3 warns about: emphasizing
// "call it only once approved" without also addressing what already counts
// as approval nudged both models toward treating a real approval message as
// insufficient. Added a third paragraph making explicit what
// ASK_USER_SECTION already establishes elsewhere in this prompt — an
// outright instruction is the decision, not something to check back on —
// applied to this tool's specific shape (approval message + a plan already
// in hand from an earlier turn or tool result).
//
// Round 3 (same suite, same providers, run right after the fix above):
// local, Ornith, and Digital Ocean now all pass cleanly, including Ornith's
// round-2 regression — confirming that was the over-generalization gap, not
// a capability ceiling. Lemonade still fails tc-002, but in a third, distinct
// shape: it now stops asking about scope/context and instead declines to
// act because the fetched issue text ("Issue #42: Refactor auth. Plan:
// migration, handler, tests.") "feels too brief" and it doesn't want to
// "hallucinate" task details from what it read as a placeholder. This is
// the same underlying trait IMAGE_SECTION already documented for Lemonade
// specifically (tools-002 in suites/tool-calling.yaml: refusing seeded image
// bytes as "looking like a placeholder") showing up against a different
// tool's terse-but-complete result. Since the wording change between rounds
// 2 and 3 demonstrably changed Lemonade's behavior (stopped asking about
// scope) rather than reproducing the identical failure, this isn't yet the
// two-rounds-unchanged signature interpreting-results.md §5 flags as a
// ceiling — added a fourth paragraph applying IMAGE_SECTION's own "don't
// second-guess a tool's result as fake or a placeholder" framing to this
// tool's shape explicitly.
const CREATE_TASKS_SECTION = `create_tasks turns an approved plan into a batch of queued tasks that run autonomously, one after
another. Call it only once the user has actually approved a plan — while still exploring options
together ("maybe split it into a migration step and a handler step, what do you think?"), keep
discussing instead; calling create_tasks mid-brainstorm jumps ahead of a decision the user hasn't
made yet.

When the plan being approved is tied to a GitHub issue or PR URL already established earlier in the
conversation — mentioned by the user, or returned by an earlier web_fetch — pass that exact URL as
trackerUrl instead of leaving it blank or re-typing/paraphrasing the issue into each task's
description. For example, if an earlier web_fetch of https://github.com/octo/repo/issues/42 returned
that issue's plan and the user now says "yes, let's go with that — set up the tasks," call
create_tasks with trackerUrl: "https://github.com/octo/repo/issues/42" copied verbatim, not a fresh
description of the issue typed from memory.

Once the user has approved, don't ask them to restate, confirm, or scope the plan further — the same
"an outright instruction is the decision" rule ask_user_routing already applies elsewhere applies
here too. A plan already sitting in the conversation from an earlier turn or tool result, paired with
a plain approval like "yes, let's go with that plan," is together enough to act on immediately: build
the task batch from what's already in hand and call create_tasks, rather than pausing to ask which
plan they meant or how much detail each task should include.

A terse tool result is still real, complete content to build from — not a placeholder to distrust or
ask about, the same way an image tool's returned bytes are real (see the image section above). A
fetched issue reading just "Issue #42: Refactor auth. Plan: migration, handler, tests." is genuinely
everything there is, not truncated or faked, and is exactly what the approved plan refers to: map it
straight onto task titles — migration, handler, tests — rather than declining to act because the
description feels too brief to be trusted.`;

interface HarnessSection {
  tag: string;
  content: string;
  // Tool ids this section's guidance depends on (issue #154) — omitted means
  // always included (identity/memory: cross-cutting, not tied to a specific
  // tool's availability). requiresAnyOf: included if at least one listed id
  // is bound. requiresAllOf: included only if every listed id is bound (used
  // by wiki_ingest, which is meaningless without both web_fetch AND
  // wiki_create_page). See filterHarnessSections() below, which is the thing
  // that actually applies these per call — buildHarnessPrompt()/
  // buildSystemPrompt() below always emit every section unfiltered, since
  // tool binding isn't known yet at agent-build time (see
  // tool-access.middleware.ts and docs/superpowers/specs/
  // 2026-09-13-tool-scoped-system-prompt-sections-design.md).
  requiresAnyOf?: string[];
  requiresAllOf?: string[];
}

const WIKI_TOOL_IDS = [
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
];

// One entry per internal tool group or behavior area, in a fixed order.
// identity/memory lead the list — they frame how the model should read the
// tool-orchestration rules that follow, not the other way around.
const HARNESS_SECTIONS: HarnessSection[] = [
  { tag: 'identity', content: IDENTITY_SECTION },
  { tag: 'memory', content: MEMORY_SECTION },
  { tag: 'notation', content: NOTATION_SECTION },
  { tag: 'wiki_navigation', content: WIKI_NAVIGATION_SECTION, requiresAnyOf: WIKI_TOOL_IDS },
  { tag: 'web_fetch', content: WEB_FETCH_SECTION, requiresAnyOf: ['web_fetch'] },
  {
    tag: 'wiki_ingest',
    content: WIKI_INGEST_SECTION,
    requiresAllOf: ['web_fetch', 'wiki_create_page'],
  },
  { tag: 'rlm', content: RLM_SECTION, requiresAnyOf: ['rlm_query'] },
  { tag: 'shell_execution', content: SHELL_EXECUTION_SECTION, requiresAnyOf: ['shell_exec'] },
  { tag: 'image', content: IMAGE_SECTION, requiresAnyOf: ['upload_image'] },
  {
    tag: 'search_skills',
    content: SEARCH_SKILLS_SECTION,
    requiresAnyOf: ['search_skills'],
  },
  {
    tag: 'create_tasks',
    content: CREATE_TASKS_SECTION,
    requiresAnyOf: ['create_tasks'],
  },
  { tag: 'ask_user_routing', content: ASK_USER_SECTION, requiresAnyOf: ['ask_user'] },
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

// Gates tool-scoped sections on tool binding (issue #154). buildSystemPrompt()
// below is unchanged and still emits every section unconditionally — it's
// built once per cached agent (see chat-agent.ts's _agents/_workspaceAgents
// maps), before any thread's tool configuration is known. This is the actual
// per-call/per-scenario filter, applied on top of that cached string by
// tool-access.middleware.ts (production, using its already-resolved effective
// tool set) and by bin/eval.ts via lib/evaluations' RunConfig.filterHarnessSections
// callback (eval scenarios, using each scenario's bound-tool set) — never a
// second source of truth for "what's available," just two callers passing in
// the set they already computed. Pure string transform: no dependency on
// tool-config, thread store, or agent-build state.
export function filterHarnessSections(prompt: string, availableToolIds: Set<string>): string {
  let result = prompt;
  for (const section of HARNESS_SECTIONS) {
    const anyOfOk =
      !section.requiresAnyOf || section.requiresAnyOf.some((id) => availableToolIds.has(id));
    const allOfOk =
      !section.requiresAllOf || section.requiresAllOf.every((id) => availableToolIds.has(id));
    if (anyOfOk && allOfOk) continue;
    const blockPattern = new RegExp(`<${section.tag}>\\n[\\s\\S]*?\\n</${section.tag}>`);
    result = result.replace(blockPattern, '');
  }
  // Removing a block can leave behind a run of blank lines (from the '\n\n'
  // join in buildHarnessPrompt()/buildSystemPrompt()) or trailing whitespace
  // if the last section got stripped — normalize both rather than trying to
  // track and remove exactly one adjacent separator per removal.
  return result.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
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
