# Wiki Duplicate Detection — False Positive Fix — Design

**Date:** 2026-10-12
**Status:** Approved (design)
**Related:** [`docs/superpowers/specs/2026-07-26-wiki-write-tooling-design.md`](2026-07-26-wiki-write-tooling-design.md) (introduced `wiki_create_page` and its duplicate-detection call into `LlmWiki.ingestPrep()`/`findSimilarPages()`)

## Purpose

`wiki_create_page`'s duplicate-detection guardrail (`LlmWiki.findSimilarPages()`
in `lib/llm-wiki/src/llm-wiki.ts`) exists to stop the agent from creating a
redundant page when a similar one already exists. In practice it fires too
often, on matches that aren't actually similar — eroding trust in the "A
similar page already exists" message to the point where it stops being
useful signal for the LLM. This spec fixes the matching mechanism itself, not
just its thresholds.

### Root cause

A confirmed real-world repro (from a thread report): proposing a page titled
**"Jellyfin"** (a homelab media server) was flagged as a duplicate of an
existing **"Authentik"** page (an SSO service) — two unrelated topics with
zero title overlap. The agent correctly identified the match as nonsensical
on its own and read the page to confirm before proceeding with `force`.

Both of today's two code paths in `findSimilarPages()` compare the **proposed
title** against **existing pages**, never the proposed page's actual body
against an existing page's actual body:

- **Hybrid path** (embeddings configured, ≥10 pages in the wiki — the common
  case, since embeddings default to enabled): runs `semanticSearch(title, {
mode: 'hybrid' })`, the same general-purpose search used by `wiki_search`.
  Its keyword half runs BM25 with the proposed title as the query against the
  **full body text** of every existing page. In the repro, the Authentik page
  apparently mentions "Jellyfin" once in passing (as one of the services
  sitting behind its SSO); because almost no other page contains that word,
  Authentik ranks #1 on the keyword axis from that single incidental mention,
  enough combined with a middling semantic rank to clear the RRF score floor.
- **Title-only fallback** (no embeddings, or <10 pages): compares the
  proposed title's significant words against each existing page's title only,
  requiring ≥60% overlap. This avoids the full-body trap above, but is still
  a single blunt signal with no corroboration — generic shared title words
  (e.g. "Setup," "Plan," "System," "Test") can produce nonsense matches here
  too, just via a different mechanism.

A second, related failure mode (confirmed by the user, not yet caught in a
thread report): **bridge pages**. This wiki's schema requires ≥2 outbound
wikilinks per page, so a page that deliberately connects two existing topics
(e.g. a "Jellyfin SSO" page describing how Jellyfin authenticates through
Authentik) will, by design, mention both. Neither existing path can tell "this
page restates what Authentik's page already covers" apart from "this page
cites Authentik while being about something else entirely" — both look like
keyword/title overlap to a title-vs-existing-page comparison. The real
distinguishing signal is whether the **new page's actual content** covers
substantially the same ground as the **existing page's actual content** — a
comparison neither path makes today.

## In scope

- Restructuring `LlmWiki.findSimilarPages()` (private method,
  `lib/llm-wiki/src/llm-wiki.ts`) into a two-stage pipeline: a cheap,
  title-only shortlist stage, followed by a content-level confirmation stage
  that compares the proposed page's actual body against each shortlisted
  candidate's actual body.
- Threading the proposed page's body (`IngestPrepInput.content`, already
  available in `ingestPrep()`) through to `findSimilarPages()`.
- Two interchangeable confirmation strategies for stage 2: embedding cosine
  similarity (when an `embeddingProvider` is configured) and a lexical
  word-overlap fallback (when it isn't, or if an embedding call fails).
- Removing the `MIN_PAGES_FOR_SEMANTIC` and `MIN_DUPLICATE_SCORE` constants
  and the RRF-based scoring they gated — both existed to compensate for
  rank-based scoring being unstable on small corpora, which doesn't apply
  once stage 2 does a direct content comparison between two specific
  documents instead of ranking against the whole corpus.
- New unit tests in `lib/llm-wiki/test/llm-wiki.test.ts` covering both
  confirmation strategies, the shortlist-rejects-everything case, and
  embedding-failure fallback.

## Out of scope

- `wiki_search` / `semanticSearch()`'s own general-purpose ranking behavior —
  unchanged. Full-body BM25 and hybrid ranking are correct for an explicit
  user search query; the problem is specific to reusing that machinery for a
  fundamentally different "is this the same document" question.
- The non-embedding title-overlap shortlist's 60%-word-match threshold itself
  — kept as-is; it already deliberately avoids full-body scanning, and
  changing its threshold is a separate tuning question from fixing what
  confirms a shortlisted candidate.
- `force: true` and `dryRun` behavior in `wiki-create-page.tool.ts` /
  `createWikiPage()` — unaffected; both are handled upstream of
  `findSimilarPages()` and keep their existing contract.
- Any change to `createWikiPage()`'s or the tool wrapper's return contract —
  `findSimilarPages()` still returns `string[]`, consumed the same way
  (`prep.existingPages[0]`).
- Final calibration of the new similarity thresholds against real-world
  wiki content — see "Open items," below.

## Design

### Pipeline

```ts
// lib/llm-wiki/src/llm-wiki.ts

private async findSimilarPages(
  proposedTitle: string,
  keywords: string[],
  proposedBody: string,
): Promise<string[]> {
  const shortlist = await this.searchByTitle(proposedTitle);
  if (shortlist.length === 0) return [];
  return this.confirmByContent(proposedBody, shortlist);
}

private async confirmByContent(
  proposedBody: string,
  candidates: string[],
): Promise<string[]> {
  if (this.embeddingProvider) {
    try {
      return await this.confirmByEmbedding(proposedBody, candidates);
    } catch (err) {
      const reason = describeEmbeddingError(err);
      this.logger.warn(
        `confirmByContent: embedding confirmation failed (${reason}), falling back to lexical overlap`,
        { err },
      );
    }
  }
  return this.confirmByLexicalOverlap(proposedBody, candidates);
}
```

- **Stage 1 — `searchByTitle()` (unchanged):** today's existing-code path,
  used universally now as a shortlist rather than only as the no-embeddings
  fallback. Significant words (length > 2) of the proposed title vs. each
  existing page's title (or filename stem); ≥60% overlap required. Never
  touches body text. If this finds nothing, `findSimilarPages` returns `[]`
  immediately — no embedding call is spent confirming a title that was never
  plausibly related.
- **Stage 2a — `confirmByEmbedding()`:** embeds `proposedBody` once via
  `this.embeddingProvider.embed([proposedBody])`. Reuses the existing
  `EmbeddingIndex` cache that `semanticSearch()` already maintains (refreshing
  any stale shortlisted candidates the same way `semanticSearch()` does today
  — that refresh-stale-pages logic gets extracted into a small shared private
  helper so it isn't duplicated between the two call sites). For each
  shortlisted candidate, computes `cosineSimilarity(proposedVec,
candidateVec)` against the candidate's cached **body** vector (not title).
  Keeps candidates scoring `≥ MIN_BODY_COSINE_SIMILARITY`.
- **Stage 2b — `confirmByLexicalOverlap()`:** no embedding call. For each
  shortlisted candidate, computes

  ```
  coverage = |significantWords(proposedBody) ∩ significantWords(candidateBody)|
             / |significantWords(proposedBody)|
  ```

  using the same "lowercased, length > 2" significant-word filter already
  used elsewhere in this file. This is deliberately **asymmetric** — it asks
  "what fraction of the new page's own vocabulary already exists in the
  candidate," not a symmetric Jaccard/Dice coefficient. A bridge page that
  mentions a long existing page in one or two sentences contributes only a
  handful of shared words against its own full body, so coverage stays low
  regardless of how long the candidate page is; a genuine near-duplicate
  shares the bulk of its substantive vocabulary with the candidate regardless
  of which of the two is longer. Keeps candidates scoring
  `≥ MIN_BODY_WORD_OVERLAP`.

### Why this fixes both observed failure modes

- **Jellyfin / Authentik:** "Authentik" shares zero significant words with
  "Jellyfin" in the title, so it's excluded at stage 1 — stage 2 (whichever
  variant) is never even consulted for that pair. This is the direct
  regression case.
- **Bridge pages (e.g. "Jellyfin SSO" mentioning both Jellyfin and
  Authentik):** stage 1 may shortlist "Jellyfin" (shared title word) and
  possibly "Authentik" if the bridge page's title also names it. Stage 2 then
  compares the bridge page's actual body against each candidate's actual
  body: a bridge page's content is substantively about the integration, not a
  restatement of either standalone entity page, so neither cosine similarity
  nor lexical coverage should clear the threshold against either candidate —
  while a page that actually does restate an existing page's content (a true
  duplicate) will.

### Thresholds

Two new named constants replace `MIN_DUPLICATE_SCORE`:

- `MIN_BODY_COSINE_SIMILARITY` — starting value **0.80**.
- `MIN_BODY_WORD_OVERLAP` — starting value **0.5** (50% coverage).

Both are best-effort starting points, not values validated against this
installation's actual embedding model and wiki content — see "Open items."

### Error handling

- Embedding call throws (provider unreachable, timeout, etc.) → caught,
  logged via `this.logger.warn` (same `describeEmbeddingError` helper already
  used elsewhere in this file), falls back to `confirmByLexicalOverlap()` for
  that call. This keeps _some_ real content confirmation active rather than
  either silently skipping confirmation (fail-open, reintroducing noise) or
  treating the shortlist as confirmed without evidence (fail-closed, today's
  bug).
- Empty wiki / no content pages: `searchByTitle()` already returns `[]` in
  this case (via `listContentPaths()` returning `[]`); `findSimilarPages`
  short-circuits before stage 2, same as today.
- `force: true` / `dryRun`: untouched — both are handled in
  `wiki-write.ts`/`wiki-create-page.tool.ts`, upstream of this function.

### API changes

- `findSimilarPages(proposedTitle, keywords, proposedBody)` — adds the
  `proposedBody` parameter. `keywords` is left as-is (it is already unused
  inside the function body today — a pre-existing fact not addressed here;
  out of scope — see "Out of scope").
- `ingestPrep()`'s single call site changes from
  `this.findSimilarPages(proposedTitle, keywords)` to
  `this.findSimilarPages(proposedTitle, keywords, input.content)` —
  `input.content` is already available on `IngestPrepInput`, no new plumbing
  needed through `wiki-write.ts` or the tool wrapper.
- No change to `IngestPrep`'s shape, `CreateWikiPageResult`, or any public
  `@tkottke90/llm-wiki` export — this is entirely internal to `LlmWiki`.

## Testing

This is a deterministic library change (word-set and vector-similarity
arithmetic), not new LLM-facing behavior — per the root `AGENTS.md` Testing
Blacklist logic, this is unit-test territory (Mocha + Chai,
`lib/llm-wiki/test/llm-wiki.test.ts`), not an eval-harness scenario. Fake
embedding adapters follow the existing inline-object convention from
`lib/rlm/test/unit/search.test.ts` (controllable per-text vectors), not the
library's own zero-vector `NullEmbeddingProvider`.

New cases in `lib/llm-wiki/test/llm-wiki.test.ts`:

1. No embedding provider, low title overlap → empty shortlist → no duplicate.
2. No embedding provider, high title overlap, low lexical body overlap
   (bridge case) → shortlisted but not confirmed → no duplicate.
3. No embedding provider, high title overlap, high lexical body overlap
   (genuine near-duplicate) → confirmed duplicate.
4. Embedding provider configured, zero title overlap — the Jellyfin/Authentik
   repro — excluded at stage 1; assert the fake adapter's `embed()` is never
   called for the rejected candidate, proving stage 2 wasn't reached.
5. Embedding provider configured, title overlap, dissimilar body vectors
   (bridge case) → shortlisted but not confirmed.
6. Embedding provider configured, title overlap, near-identical body vectors
   → confirmed duplicate.
7. Embedding provider's `embed()` rejects → falls back to lexical overlap
   without throwing, and confirms/rejects per the lexical result.
8. Existing title-based case (`'detects an existing similar page via keywords
match'`) still passes under the new orchestration.

Existing regression coverage to re-run, not modify:

- `api/src/agents/tools/wiki-create-page.tool.test.ts`'s `'does not emit a
wiki_updated event on a duplicate page'` — creates the same title + body
  twice with no embedding provider configured; should still pass unchanged,
  since identical content trivially clears either stage-2 threshold.
- `api/src/services/wiki-write.test.ts`'s create-duplicate case, same
  reasoning.

## Open items deferred to later work

- **Threshold calibration.** `MIN_BODY_COSINE_SIMILARITY` (0.80) and
  `MIN_BODY_WORD_OVERLAP` (0.5) are starting guesses, not measured against
  this installation's actual embedding model (`nomic-embed-text` via Ollama,
  by default) or real wiki content. Expect a follow-up tuning pass — most
  likely informed by running the implementation against `config/kb`'s real
  domains and a handful of deliberately-constructed bridge-page and
  genuine-duplicate test cases — once this ships.
- Extracting the `0.6` title-overlap threshold inside `searchByTitle()` into
  a named constant (currently an inline literal) — a small readability
  cleanup touched in passing if convenient during implementation, not a
  requirement of this spec.
- The pre-existing unused `keywords` parameter on `findSimilarPages()` —
  noted above, not addressed here.
