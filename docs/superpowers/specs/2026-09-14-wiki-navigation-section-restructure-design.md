# Restructure WIKI_NAVIGATION_SECTION as a Decision Procedure — Design

**Date:** 2026-09-14
**Status:** Draft
**Related:** [Issue #186](https://github.com/tkottke90/amazing-hashbrown/issues/186)

---

## Goal

Reduce Lemonade's (GLM-4.7-Flash-GGUF) confirmed sampling flakiness on the default, no-directive domain-routing behavior `WIKI_NAVIGATION_SECTION` (`api/src/agents/system-prompt.ts`) governs — 4/7 pass rate across identical-condition reruns on `suites/explicit-tool-syntax.yaml`'s baseline control scenarios (`ets-002`, `ets-004`), per PR #184's follow-up measurement comment. This is confirmed as real model-sampling variance, not a fixable wording gap (failures scatter across different rounds with no common reasoning-shape cause) — so this is not another wording tightening in the style of the section's existing 16-entry history. It's a structural rewrite: convert the section from flowing prose to a numbered decision procedure, on the hypothesis (drawn from PR #184's own diagnosis of a related ceiling — "a structural fix... is more likely to move it than another paragraph edit") that less content competing for attention, laid out as an explicit checklist, is more resistant to sampling variance than the same substance spread across ~13 narrative paragraphs.

---

## Problem

- `WIKI_NAVIGATION_SECTION` has been tightened 16 times (see the comment block above the constant in `system-prompt.ts`) in response to specific eval failures, each fix adding a paragraph, a contrastive example, or a clarifying sentence. The result is substantively correct but dense: roughly 13 paragraphs covering domain resolution, tie-breaking, post-resolution routing (orient vs. search vs. read), write-path rules, and priority overrides, several of which restate the same underlying rule (wikiId scoping) with overlapping worked examples (paragraphs governing `wnav-009`/`wnav-013`/`wnav-002` in the current text).
- PR #184's 7-sample measurement confirms Lemonade's `ets-002`/`ets-004` flakiness (~57% pass rate) is genuine variance, not a reachable wording gap — the standard fix pattern this file has used 16 times (add a contrastive example) doesn't apply, because there's no single failure shape to anchor an example against.
- The issue's own dev notes flag a density/restructuring pass as a plausible but untried lever, explicitly out of scope for the finding alone to justify — this design is that follow-up.
- No tool-surface changes are implicated (unlike issue #155, which found the prior `wnav-009` "ceiling" was actually a missing `wikiId` param on `wiki_search`). This is purely a system-prompt content/structure question.

---

## Scope

**In scope:**

- Rewrite `WIKI_NAVIGATION_SECTION`'s content (lines ~425–513 of `api/src/agents/system-prompt.ts`) from prose paragraphs into a numbered decision procedure (four steps: resolve domain → resolve `wiki_locate`'s result → act on the resolved `wikiId` → priority overrides), with contrastive examples pulled into short bulleted lists under the relevant step rather than woven into paragraphs.
- Preserve every distinct rule and every existing worked example from the current text — verified against the specific eval scenario each one protects (`wnav-001` through `wnav-013` in `suites/wiki-navigation.yaml`, plus `wiki-write.yaml`'s `wwrite-006`–`009` for the write-rejection paragraph). See "Rule inventory" below.
- Update `api/src/agents/system-prompt.test.ts` assertions that match literal substrings of the old text.
- Append a 17th entry to the tightening-history comment block above the constant, following the file's established convention (per `interpreting-results.md` §4): what motivated this change, what changed, what to check on the next eval run. This is a structural rewrite, not a new-rule tightening — the entry should say so explicitly, distinguishing it from the prior 16.

**Out of scope:**

- No change to `suites/wiki-navigation.yaml`'s scenario assertions — they test behavior, not wording, and should still pass unchanged if the rewrite preserves the underlying rules correctly.
- No change to `WEB_FETCH_SECTION`, `WIKI_INGEST_SECTION`, or any other `HARNESS_SECTIONS` entry.
- No change to the tool-gating registration (`requiresAnyOf: WIKI_TOOL_IDS` at line 933) — investigated and rejected as a lever for this issue specifically, since the eval suite binds the full wiki toolset to every scenario (no `excludeTools` in `wiki-navigation.yaml`), so gating a sub-block wouldn't reduce what the model actually sees during the flaky scenarios.
- No new rules or behaviors beyond what the current text already specifies. In particular, no "read before update" instruction is being added for `wnav-011` — that behavior already passes on a 3/3 model consensus with zero prompt guidance (per `wnav-011`'s own scenario comment), so adding wording for it would be unjustified scope creep, not a fix.
- No eval runs from this environment — no local model server is reachable here. Validation happens locally, by the user, after this lands.

---

## Rule inventory (current text → new location)

Confirms nothing is dropped in the rewrite:

| Current rule                                                                                               | Protects (scenario)                               | New location                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| Tool descriptions (4 wiki tools)                                                                           | —                                                 | Unchanged intro                  |
| Skip `wiki_locate` only if domain established earlier, or topic so specific no other domain could cover it | `wnav-001`, `wnav-007`, `wnav-008`                | Step 1, first three bullets      |
| "Merely sounding personal ≠ established domain"                                                            | `wnav-007`                                        | Step 1, fourth bullet            |
| Favorite-color (skip) vs. growth (ambiguous) contrastive example                                           | `wnav-008` vs. `wnav-007`                         | Step 1 examples                  |
| Meta-question ("which part of the KB") ≠ personal-fact question                                            | `wnav-001`                                        | Step 1, second bullet + example  |
| Technical/setup topic (Verdaccio), including possessive phrasing, isn't an outright personal match         | `wnav-010`, `wnav-010b`, `wnav-010c`              | Step 1, fourth bullet + example  |
| No-match → report honestly, don't fabricate                                                                | `wnav-005` (via MEMORY/IDENTITY, referenced here) | Step 2, first bullet             |
| wikiId travels directly into `wiki_search`/`wiki_orient`, no separate confinement step                     | `wnav-009`, `wnav-013`                            | Step 3, search bullet            |
| Concrete fact → scoped search, not orient detour                                                           | `wnav-009`, `wnav-013`                            | Step 3, search bullet + examples |
| Overview request → orient even on single match                                                             | `wnav-002`                                        | Step 3, orient bullet + example  |
| Tie-break only with real conversational info, never fabricated                                             | `wnav-004`                                        | Step 2, tie bullet               |
| Reported tie outranks the model's own hunch; call `ask_user`, don't decide                                 | `wnav-004`                                        | Step 2, tie bullet               |
| Write directly when nothing on-topic exists; no pre-check search, no asking where                          | `wnav-012`                                        | Step 3, create bullet            |
| Tool's own result outranks default guidance                                                                | `wnav-006`                                        | Step 4, first bullet             |
| Write rejection (known-wrong wiki) vs. unrecognized wikiId; retry with only wikiId swapped                 | `wwrite-006`–`009` (wiki-write.yaml)              | Step 4, second bullet            |

---

## Design

### Replacement text for `WIKI_NAVIGATION_SECTION`

```
You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content, across every domain by default or scoped to one via wikiId.
- wiki_read_page: read a specific page's full content once you've found it.

Follow this procedure in order — each step only applies when the step before it didn't already
resolve things.

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

   Examples:
   - "What's my favorite color?" → skip (no domain but the user's own could ever answer this).
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
   - Multiple candidates (a tie) → narrow to one only using something real: the routing notes
     attributing the request to a single candidate, or something the user actually said elsewhere
     in the conversation. Don't invent a narrower context to retry wiki_locate with, and don't let
     a candidate merely feeling more plausible to you count as real information — that's the same
     mistake, and announcing your pick in your reply doesn't fix it either. If nothing real breaks
     the tie, call ask_user and ask which domain they mean; a reported tie stays a tie until the
     user or the conversation actually resolves it. Once narrowed, go to step 3.

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
     the confirmation already answered that.
```

Exact line-wrapping/whitespace in the actual template literal is an implementation-time detail (must match the file's existing wrap width and be verified against the JS template-literal source, per `interpreting-results.md` §4) — the content and structure above are fixed by this design.

### Tightening-history entry (17th)

Append above the constant, after entry sixteen, following the same format: cites issue #186 and PR #184's 7-sample flakiness measurement as the motivating evidence, states plainly that this is a structural rewrite rather than a new wording tightening (distinguishing it from entries 1–16), and notes what to check on the next real eval run — regression-check every previously-passing `wiki-navigation.yaml` scenario, and re-measure Lemonade's `ets-002`/`ets-004` pass rate (once `suites/explicit-tool-syntax.yaml` is available, post PR #184 merge) against the prior 4/7 baseline.

---

## Testing

- Unit (`system-prompt.test.ts`): update any assertion matching removed/changed literal substrings of `WIKI_NAVIGATION_SECTION`; verify the section still renders correctly wrapped in its `<wiki_navigation>` tag.
- Eval (run locally by the user, not in this environment):
  - `suites/wiki-navigation.yaml` against all configured models (Ornith, Lemonade, local) — regression check. Every currently-passing scenario should still pass; this validates the rule inventory above actually transferred.
  - `suites/explicit-tool-syntax.yaml`'s `ets-002`/`ets-004` against Lemonade, once available — the actual target. Compare against the 4/7 baseline from PR #184's measurement comment. No pass-rate guarantee is being made; this is a hypothesis test, not a fix with certain results.
- If the rewrite regresses a previously-passing `wiki-navigation.yaml` scenario, diagnose per `interpreting-results.md`'s standard process (check `calledTools`, read `reasoningContent`) before assuming the restructuring itself is the cause — could also be an unrelated model-sampling variance hit.
