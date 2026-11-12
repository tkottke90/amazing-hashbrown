# Research: A Read-Only, App-Published Harness-Docs Wiki vs. a Dedicated Tool/Skill

A third, narrower pass building directly on two prior documents — read first,
cross-referenced rather than repeated here:

1. [`docs/research/harness-self-awareness-progressive-disclosure.md`](./harness-self-awareness-progressive-disclosure.md)
   (doc 1) — surveyed this repo's four existing on-demand mechanisms against
   issue [#334](https://github.com/tkottke90/amazing-hashbrown/issues/334)
   (Wayfinder Map: Agent-Invocable Skills, unimplemented) and issue
   [#410](https://github.com/tkottke90/amazing-hashbrown/issues/410)
   (system-prompt bloat audit).
2. [`docs/research/docs-qa-tool-jit-retrieval.md`](./docs-qa-tool-jit-retrieval.md)
   (doc 2) — vetted "point RLM at harness docs" against this repo's own
   ADR-001 (`docs/ADR.md`), which already separates RLM (unstructured,
   system-external text) from structured/system-owned content, and found
   neither Ollama nor current Claude models support forced tool-choice, so
   "ask first" can only ever be optional — with this repo's own RLM work
   (`docs/Design/RLM.md`) showing structural tool design beats trying to
   force a call.

## 1. The question, restated precisely

The user's own framing: during a conversation, either the user or the agent
may have a question *about the harness itself* ("What is a `Widget`?",
"When should I use `spawn_sub_agent`?", "What is the `Self` wiki?"). Would it
be better to answer these with a dedicated tool/skill (per docs 1–2's
findings), or to lean on the existing LLM Wiki and publish a new, read-only,
app-published domain of harness documentation — reasoning that the wiki
already exists, already lets the agent learn over time, and a new domain
would let the agent "pull domain knowledge naturally, without new
mechanisms"? The user names the biggest risk themselves: getting "lost in
the fog" of wikis, and someone eventually trying to write to it.

This stays a survey for a design discussion, per both prior documents' own
convention — it states what was found and why, not what to build.

## 2. "Self" is a loaded example — and the proposal's own question about it is the tell

`api/src/services/wiki.ts:16-33`, `DEFAULT_DOMAINS`: two built-in domains ship
today.

```ts
{ id: 'user', domain: 'user', routingNotes: ['user preferences, personal context, and biography -> user'] }
{ id: 'self', domain: 'agent identity, values, decisions, and reflection',
  routingNotes: ["the agent's own reasoning, values, principles, decisions, mistakes, and growth -> self"] }
```

`self` is the agent's own introspective/identity journal — values, decisions,
mistakes, growth — not documentation about the harness or app.
`GLOSSARY.md:116` confirms this is just one of two **Wiki Domains**, no more
special than `user`: "No Wiki Domain, including `self`, is special-cased
anywhere in the write or persistence path — only Write Scope narrows which
Wiki Domains a given write may target."

The proposal's own example question — "What is the `Self` wiki?" — is
therefore itself a *meta*-question about the wiki system's domain structure,
not a question the `self` domain's own content could ever answer (nothing
written into `self` by the agent would explain what `self` *is for*
systemically). This is exactly the kind of harness self-knowledge no existing
mechanism provides (doc 1 §2.6's coverage table), and it's worth being
precise about: a harness-docs wiki domain answering "what is the Self wiki"
would need to document the *wiki system itself*, which is a different
content category from what `self` or `user` ever hold today — closer to
"documentation about the knowledge-base feature" than to "a third knowledge
domain alongside the other two."

## 3. The fog risk is real, already measured, and independent of this proposal

### 3.1 Two domains already produced a long, documented history of routing failures

`api/src/agents/system-prompt.ts:1-760` (the comment block immediately above
`WIKI_NAVIGATION_SECTION`) records at least fifteen explicitly numbered
"tightening" rounds of real auto-eval failures against `suites/wiki-navigation.yaml`
and `suites/wiki-navigation-heldout.yaml` — with just **two** domains. A
representative sample, verbatim from the source:

- Models conflating `user` and `self`: "wnav-009 (routing hints narrow 'user'
  vs 'self' down to 'user'): the model reasoned 'the user domain covers
  this' and skipped straight to wiki_search... silently re-includes the
  'self' domain the routing note had just ruled out" (lines 40-50).
- An abstract rule alone wasn't enough; the fix needed "one concrete
  contrastive example, since a worked pair (skip this / don't skip that)
  anchors better than a rule stated only in the abstract" (lines 25-27) —
  and even that needed repeated follow-on tightening as new phrasing
  variants surfaced (lines 60-65, 112-128, 173-200).
- `wnav-009` specifically reproduced the identical collapse for one model
  across at least seven to ten consecutive runs (lines 282-285, 342-343,
  "ninth/eleventh entries") before being characterized as "a stable, targetable
  gap, not noise" (line 142) and finally fixed at the fifteenth tightening,
  "issue #155" (line 386).
- `wnav-004` (a genuine tie between domains) is explicitly logged as a
  "confirmed capability ceiling" for one model family that tightened wording
  never closed (lines 275-292, 581-653).

This is primary-source, in-repo evidence that domain-routing confusion is a
real, already-extensively-measured failure mode with only two domains, not a
hypothetical risk a new proposal introduces from scratch.

### 3.2 `wiki_search` already competes across every domain by default, and `wiki_locate`'s scoring is global

`api/src/agents/tools/wiki-search.tool.ts:8-14` — the `wikiId` field's own
description: "Omit to search across every registered domain at once." Any
call that skips the (fragile, per §3.1) domain-resolution step falls into
this all-domain search. `lib/llm-wiki/src/registry.ts:93-109`'s `resolve()`
scores every active wiki's id/domain/tag/routing-note hits against free text
and returns either a single match, an `ambiguous` tie, or `noMatch` — i.e.
the scored-resolution step that §3.1's eval history was already tuning is a
single call across the *entire* registry, not domain-by-domain. Adding a
third domain doesn't create a new side-channel of ambiguity; it adds one
more candidate into the exact scored-tie mechanism that `wnav-004`/`wnav-009`
already show this repo struggling to keep reliable with two.

### 3.3 The 2026-10-18 misfiling incident shows what "about the app" content does to this registry today — and that incident has since been root-caused more precisely than it first appeared

GitHub issue [#333](https://github.com/tkottke90/amazing-hashbrown/issues/333)
(open) originally looked like a write-scope bypass: AfterAgent, running in an
unbound `hateos-url-manager` thread, auto-extracted a general
`.npmrc`/private-npm-registry infrastructure fact and wrote it into the
**`amazing-hashbrown`** wiki — a domain literally named after this
application — instead of anywhere workspace-relevant.

The issue's own first comment (2026-10-18T23:15:31Z) root-causes this
precisely, and the diagnosis matters for this proposal:

> "The guardrail is doing exactly what #79/#202 spec'd: it stops a workspace
> from stealing another workspace's *bound* domain. It was never designed to
> stop an *unbound* workspace from writing into any other unbound domain in
> the registry... The actual bug is one level up, in the `extract` step
> itself... `classify` says `shouldWrite: true`, the pipeline is committed to
> writing *somewhere*... with no way to say 'none of these actually fit.'"

This was fixed (ADR-0014, ADR-0015; design doc
`docs/superpowers/specs/2026-10-18-afteragent-domain-fit-gate-design.md`;
shipped in `api/src/agents/after-agent.ts:140-172, 533-538`): `extract` now
emits a 1–10 **Domain Fit Score**, banded into **Write** (8–10, commits
immediately), **Review** (5–7, creates a human-reviewed **Placement Review
Task** instead of writing — `after-agent.ts:311-350`), and **Drop** (1–4,
no-op) — but **only under Open Scope** (`after-agent.ts:533-538`:
`scope.kind === 'open' ? fitScoreBand(...) : 'write'`; under Locked Scope the
band is always `'write'`, since the one Bound Wiki is the only candidate).

**What this means for the proposal, precisely, and why the fix doesn't close
the risk it might seem to:** the Fit Gate stops a *weak or uncertain* match
from auto-committing (the exact shape of the original incident — a
software-infra fact with no genuinely on-topic unbound domain available). It
does **not** stop a *strong, confident, but still wrong* match — that still
lands in the Write Band and commits with no human review. A harness-docs
domain, being a domain whose `domain`/tags/routing-notes are *literally about
this application*, is an unusually good textual match for exactly the class
of content that produced the original incident (generic infrastructure/
system facts an unbound thread surfaces) — i.e. the one domain in the
registry most likely to score an honest 8–10 "fit" for miscellaneous
"this is a fact about the system" content is precisely a dedicated
harness-docs domain, which is the opposite of what a domain meant to hold
curated, versioned documentation should be absorbing. The Fit Gate that
closed the *original* #333 shape (`ext-007-fit-score-low-for-poor-match`,
named explicitly in the design doc as "the regression scenario for #333
itself") was never designed to, and doesn't, protect a domain from being a
too-good semantic magnet. (Note: issue #333 is still open on GitHub as of
this writing, despite the fix's code already being in `main` — this document
doesn't resolve whether that's an oversight or pending verification; flagged
as a minor state discrepancy, not evidence against the fix's existence.)

## 4. What "read-only" would actually require, and whether checked-in files change that

### 4.1 No existing concept of a permanently-unwritable domain — confirmed at both layers

`api/src/services/wiki-archive-guard.ts:8-14`, `isWikiDomainArchived()`'s own
doc comment: "A domain with no owning project (e.g. the built-in
'user'/'self' wikis, or a manually registered one) never matches and is
always writable here." Archiving only blocks a domain once its owning
project closes — it doesn't apply to a domain that never had one, which a
harness-docs domain, by construction, wouldn't.

`api/src/services/wiki-write-scope.ts:19-26`, the `WikiWriteDenial` union:
`'locked' | 'owned-by-another-workspace' | 'unresolved'`. There is no fourth
reason meaning "this domain is permanently read-only" — every denial reason
that exists today is about *which workspace* owns a domain, never about a
domain being unwritable in principle. `GLOSSARY.md:116` states the same
thing from the other direction: "No Wiki Domain, including `self`, is
special-cased anywhere in the write or persistence path."

Traced one level further, under Open Scope (the scope a harness-docs
domain — owning no workspace — would always fall under for any writer):
`checkWikiWrite`'s `'open'` branch
(`wiki-write-scope.ts:94-97`) allows a write to any `wikiId` **not** in
`excludedWikiIds`, and `excludedWikiIds` is populated only from
`store.listBoundWikiIds()` — domains bound to *some other* workspace. A
harness-docs domain, owning no workspace, is never in that excluded set, so
`wiki_create_page`/`wiki_update_page` would accept a write to it from any
unbound thread today, exactly as they would for `user` or `self`. **Making
it actually read-only is new write-guard logic — a new denial reason, checked
at the same point `checkWikiWrite`/`isWikiDomainArchived` already run — not
a property the existing design hands you by registering one more domain.**

### 4.2 Shipping it as checked-in markdown changes distribution, not enforcement

`lib/llm-wiki/src/registry.ts:143-200` shows a wiki domain's on-disk location
is configurable per entry: `create()`'s `CreateWikiInput.path` may be an
absolute path (`path.isAbsolute(relPath) ? relPath : path.join(this.wikiRoot, relPath)`,
line 145), and `register()` can register an *already-existing* on-disk
directory anywhere, reading its domain from that directory's own
`SCHEMA.md` (lines 174-199). Mechanically, nothing stops a harness-docs
domain's content from being checked-in markdown living under e.g.
`docs/harness-wiki/` in this repo (versioned with the app, updated via normal
PRs, present even in the Docker image) rather than under the gitignored
`env.wikiRoot` (`api/src/services/wiki.ts:40`, defaulting to
`./config/kb` — itself under the gitignored `config/` directory per root
`AGENTS.md`).

But this only changes *where the bytes start* and *how they're authored*; it
does not by itself close the write path described in §4.1. The write-guard
layer has no concept of "this domain's files happen to live in the repo, not
`config/`" — `wiki_create_page`/`wiki_update_page` would still accept a
`wikiId` pointing at it, under the identical Open Scope reasoning as any
other unbound domain, and would then write into whatever directory
`registry.ts`'s `resolvePath()` resolves to, repo-checked-in or not. A
checked-in-file-only approach would need **either** the same new write-guard
check §4.1 says is missing (applied regardless of file location), **or** an
operational control outside this application's own design (e.g. a read-only
container filesystem layer in the Docker image) that `npm run dev`'s local
checkout would not have, making it an inconsistent protection at best, not a
design-level guarantee. Checked-in files solve the *provenance/versioning*
half of "read-only, app-published" cleanly; they do not solve the
*enforcement* half, which is the part issue #333's history (§3.3) shows
actually matters.

## 5. Is there a genuine zero-marginal-system-prompt-cost advantage? — yes, specifically, and more precisely than the brief's framing assumed

### 5.1 The prompt text itself never enumerates domains

`api/src/agents/system-prompt.ts:758-870`, the full `WIKI_NAVIGATION_SECTION`
text actually sent to the model, names no domain IDs. Every worked example
("What's my favorite color?", "I need to generate a new NPM token for my
Verdaccio instance", "What have you noticed about growth lately?") teaches a
*procedure* for resolving an unknown domain, never a fixed list. The one
place `user`/`self` appear verbatim inside the prompt text itself
(lines 1593-1595) is a single illustrative example of how to translate a
*tool result* into plain language ("Available domains: user, self." becomes
'I don't have anything on that'") — an example, not an enumeration that would
need editing when a third domain is added.

### 5.2 The domain list is assembled dynamically, at call time, never baked into the prompt

`api/src/agents/tools/wiki-locate.tool.ts:24-34` builds its "Registered
domains" listing from `registry.list()` and `registry.routingNotes()` on
every call. `wiki-search.tool.ts:34` does the same via `registry.list()`.
Neither is prompt text — both are tool-result strings generated fresh each
invocation. A new domain is visible to the model only through these dynamic
results, never through a prompt edit.

### 5.3 The wiki's body tools are already bound in every thread, by default

`api/src/agents/tool-catalog.ts:224-291` — `wiki_search`, `wiki_read_page`,
`wiki_locate`, `wiki_orient`, and every other wiki tool carry
`alwaysOn: true` in the tool catalog, meaning they're bound in a chat thread
by default, unlike MCP tools (default-off per doc 1 §2.3) or a not-yet-built
`invoke_skill`. Put together with §5.1–5.2: **a new wiki domain costs
literally zero additional system-prompt tokens and zero additional
tool-schema bytes**, because the section describing the wiki tools doesn't
name domains, the domain catalog is read dynamically, and the tools
themselves are already paid for in every turn regardless of this proposal.

### 5.4 This advantage is real but not unique in kind — and the real contrast is elsewhere

`SEARCH_SKILLS_SECTION` (`system-prompt.ts:1866-1871`) and
`MCP_TOOL_DISCOVERY_SECTION` (lines 1655-1668) show the identical
dynamic-catalog property already exists for skills and MCP tools: neither
section names a specific skill or MCP tool, and `search_skills`/
`search_mcp_tools` look theirs up by keyword at call time. So "a dynamic
catalog costs nothing extra per item" is not unique to the wiki — this repo
already proved that shape for skills, independently.

The genuine, repo-verified asymmetry is narrower than "wiki = free, tools
aren't": `search_skills` only ever returns a pointer (name/slash-command/
description, doc 1 §2.3) — a human still has to type `/command` to load a
skill's body, so it doesn't close the mid-conversation self-answering gap
this proposal is about. Issue #334's `invoke_skill` is the mechanism that
*would* close that gap for skills, but it is a **net-new tool that doesn't
exist yet** — its first binding would cost a new tool schema (sent every
turn it's bound) plus a new always-on section of comparable size to
`SEARCH_SKILLS_SECTION`/`MCP_TOOL_DISCOVERY_SECTION` (doc 2 §2 measured
`RLM_SECTION` plus its tool schema at roughly 550 tokens combined, by a
chars÷4 estimate, as the closest comparable "new Q&A-shaped tool" cost). The
wiki route pays none of that *additional* cost specifically because its
body-read tools (`wiki_search`, `wiki_read_page`) are already bound,
already-described, always-on tools today — the saving is real, but it's a
saving on *reusing infrastructure already paid for*, not a property
intrinsic to "being a wiki" that a dedicated tool could never also have if
it, too, rode on an existing always-on tool rather than introducing a new
one.

## 6. Eval investment this would need, as a concrete proxy

`suites/wiki-navigation.yaml` (15 scenarios: `wnav-001` through `wnav-013`,
with `wnav-010b`/`wnav-010c` variants) plus `suites/wiki-navigation-heldout.yaml`
(9 scenarios, `wnavh-*`) — 24 scenarios total, built up over the
fifteen-plus documented tightening rounds cited in §3.1 — is what this repo
needed to get routing reliability between **two** domains to its current
state, and §3.1 shows at least one cross-model "capability ceiling" (`wnav-004`)
that wording alone never fully closed. Per `AGENTS.md`'s Evaluation-Driven
Development rule 1 ("write at least one failing eval scenario first... before
implementation"), a third domain would need its own round of this same
eval-driven tightening to reach a comparable bar — this is not a one-time
registration cost, even though §5 shows the token cost is zero.

## 7. Relating this specifically to issue #334's stated exclusion

Issue #334's body states its reason for excluding the wiki directly:

> "Not the wiki: app self-documentation is deliberately kept off the
> LLM-Wiki. The wiki is this app's dynamic, agent-writable memory system —
> its AfterAgent auto-write path already demonstrably misfiles content with
> no human review (see #333) — so static app self-documentation stays
> structurally outside it rather than depending on tighter routing notes to
> avoid collisions."

Three things follow from §§3–5 above, stated plainly without resolving the
tension:

1. **A permanently read-only domain, if the missing write-guard logic from
   §4.1 were actually built, would fully close the specific channel #333
   exercised** — the content could never be the thing `extract` writes to,
   because the domain could never be a write target at all, which is a
   stronger guarantee than the Fit Gate gives any other unbound domain
   today (§3.3 shows the Fit Gate still lets a strong-but-wrong match
   auto-commit). This is a meaningfully different proposal shape than what
   #334 excluded — a normal, writable domain — and #334's own cited
   rationale (#333) does not, by itself, rule out a domain that can never be
   written at all.
2. **But that protection is conditional on building the exact mechanism §4.1
   says doesn't exist yet.** A harness-docs domain that is read-only only by
   convention or documentation, not by an enforced guard, remains exactly as
   exposed as `amazing-hashbrown` was in the original incident — and, per
   §3.3, is an unusually strong Fit-Score magnet for the kind of generic
   "about this system" content that incident involved, meaning an
   unenforced read-only domain could be a worse outcome than today's status
   quo, not a neutral one.
3. **Write protection, even fully built, says nothing about the read-side
   fog risk in §3.** `wiki_locate`'s scored resolution and `wiki_search`'s
   default all-domain ranking (§3.2) run identically over a read-only domain
   as over any other registered one — nothing in the write-guard layer
   touches `resolve()` or `semanticSearch()`. So read-only status would
   neutralize #334's stated *write-trust* concern (conditionally, per point
   2), while leaving the *routing/ambiguity* concern — the one this repo's
   own 15-round `wnav-*` eval history (§3.1) shows is real with only two
   domains — completely untouched.

Separately, issue #334's own body lists its remaining, unscoped example
topics explicitly: "The remaining 2 of the original 5 example topics
(dashboard system, **wiki system Q&A**) beyond the Configuration/Workspaces
pilots — revisit once the pilots prove the mechanism out." The repo's own
standing design direction has already earmarked "questions about how the
wiki system itself works" — which covers several of the proposal's own
example questions, including "How do I determine the domain for a wiki?" and
arguably "What is the `Self` wiki?" (§2) — as a future `invoke_skill`-style
topic, not a wiki-domain topic, independent of this specific proposal.

## References

**Repo** (read at commit `c0ab2d6`, "Add research on a JIT docs-Q&A tool for
shrinking the system prompt" — `docs/adr/0011-agent-invocable-skills-separate-flag-from-tool-gating.md`
still does not exist and `GLOSSARY.md` still lives at the repo root, not
under `lib/skills-manager/`, matching doc 1 §3.1's noted discrepancy
unchanged):

`api/src/services/wiki.ts` (`DEFAULT_DOMAINS`, lines 16-33; `getWikiRegistry`,
line 40); `api/src/services/wiki-archive-guard.ts` (`isWikiDomainArchived`,
lines 8-14); `api/src/services/wiki-write-scope.ts` (`WikiWriteDenial`, lines
19-26; `checkWikiWrite`, lines 90-101); `api/src/services/wiki-write.ts`
(`createWikiPage`, `scopeDenial`); `api/src/agents/tools/wiki-search.tool.ts`
(lines 6-23); `api/src/agents/tools/wiki-locate.tool.ts` (lines 5-62);
`api/src/agents/tools/wiki-create-page.tool.ts`;
`api/src/agents/tools/wiki-write-guard.ts`; `api/src/agents/system-prompt.ts`
(comment history, lines 1-760; `WIKI_NAVIGATION_SECTION`, lines 758-870;
`SEARCH_SKILLS_SECTION`, lines 1866-1871; `MCP_TOOL_DISCOVERY_SECTION`, lines
1655-1668; `WIKI_TOOL_IDS`/`HARNESS_SECTIONS`, lines 2114-2140);
`api/src/agents/tool-catalog.ts` (wiki tool entries, `alwaysOn: true`, lines
224-291); `api/src/agents/after-agent.ts` (`ExtractOutputSchema`/`fitScoreBand`,
lines 140-172; Placement Review Task construction, lines 311-350; write-scope
resolution, lines 424-429; candidate-domain filtering, line 503; band gate,
lines 533-538); `lib/llm-wiki/src/registry.ts` (`CreateWikiInput.path`,
`create`, `register`, lines 52-200; `resolve`, lines 93-109);
`lib/llm-wiki/README.md`; `GLOSSARY.md` (Wiki Domain, line 116; Domain Fit
Score / Write Band / Review Band / Drop Band / Placement Review Task, lines
139-161); `docs/adr/0014-afteragent-gates-on-domain-fit-not-mandatory-binding.md`;
`docs/adr/0015-review-band-becomes-a-placement-review-task.md`;
`docs/superpowers/specs/2026-10-18-afteragent-domain-fit-gate-design.md`;
`suites/wiki-navigation.yaml`; `suites/wiki-navigation-heldout.yaml`; root
`AGENTS.md` § gitignored `config/`; GitHub issues
[#334](https://github.com/tkottke90/amazing-hashbrown/issues/334) (open,
full body fetched via `gh api repos/tkottke90/amazing-hashbrown/issues/334`),
[#333](https://github.com/tkottke90/amazing-hashbrown/issues/333) (open,
full body and first comment fetched via
`gh api repos/tkottke90/amazing-hashbrown/issues/333` and
`.../issues/333/comments`);
[`docs/research/harness-self-awareness-progressive-disclosure.md`](./harness-self-awareness-progressive-disclosure.md)
and
[`docs/research/docs-qa-tool-jit-retrieval.md`](./docs-qa-tool-jit-retrieval.md)
(direct prior documents, cross-referenced throughout rather than repeated).

## Caveat

§3.3's characterization of issue #333's current status is based on the
issue's own first comment (dated 2026-10-18, the same day as the Fit Gate
design doc and the ADRs it cites) plus the shipped code in `after-agent.ts`
matching that design doc's spec exactly — but the issue itself is still
flagged `open` on GitHub as of this pass, with no closing comment confirming
the fix is considered final or that the already-misfiled pages from the
original incident were ever cleaned up (the design doc explicitly marks that
cleanup "out of scope... that's normal wiki operation"). This document treats
the Fit Gate as shipped and functioning per its own code and tests, but does
not treat issue #333 as formally resolved, since nothing in the repo states
that it is.

No additional primary external source beyond what doc 1 §4.2 already cites
(Anthropic's "Effective context engineering for AI agents") was found to
speak specifically to mixing curated/versioned reference content with a
dynamic, agent-writable memory store — this pass is primarily a repo-internal
verification exercise, per its own scope, and no further external search was
forced to manufacture a citation that doesn't exist.
