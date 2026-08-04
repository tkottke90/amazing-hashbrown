# Architecture Decision Records

This file captures significant architectural decisions, their context, the evidence that shaped them, and the rationale for the outcome. Entries are additive — decisions are never deleted, though they may be superseded by later entries.

---

## ADR-001: RLM and LLM Wiki Serve Distinct, Non-Overlapping Domains

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** Engineering

---

### Context

During implementation of the `rlm_query` chat agent tool (connecting the `@tkottke90/rlm` library to the agent), five evaluation scenarios were written to exercise the RLM + wiki read-page pipeline. The scenario set was evaluated across three models (ornith, glm, local/qwen3.5:4b) over four auto-eval rounds.

The core hypothesis was that RLM could benefit the agent when wiki pages exceed the read threshold — the agent would call `wiki_read_page(truncate: false)` to get full content, pass it as a corpus to `rlm_query`, and receive a targeted answer without dumping the full page into context.

---

### Findings

**3 of 5 scenarios passed consistently across all models and rounds:**

- `rlm-001` — truncation notice causes the correct two-step sequence (`wiki_read_page` → `rlm_query`)
- `rlm-003` — agent accurately reports the specific fact from a seeded `rlm_query` result
- `rlm-004` — agent answers a small page directly without over-calling `rlm_query`

**2 scenarios were ceiling-flagged across all 3 models in every round:**

- `rlm-002` — "rlm_query receives the full corpus as its argument"
- `rlm-005` — "agent passes a large web_fetch result as the corpus to rlm_query"

**Structural weakness uncovered:** In both ceiling-flagged scenarios, the corpus text is present in the seeded prior turns, making it part of the model's visible context. Large-context models answered the targeted question directly — correctly — without delegating to `rlm_query`. From the model's perspective this is optimal behavior: the answer is already available, so calling an additional tool adds latency and cost with no benefit.

Crucially, this is not a fixture size problem. Increasing the corpus length does not change the structural dynamic: as long as the corpus fits anywhere in context, the model will use it directly. The ceiling is architectural, not a calibration issue.

---

### Analysis

The eval results surfaced a deeper insight about what RLM is for.

**The wiki is already distilled.** Wiki pages are structured, summarized, cross-linked knowledge — the output of a deliberate distillation process. Using RLM to extract targeted answers from wiki pages would re-extract from already-extracted content: doing the work twice. The wiki's graph of relationships (cross-links, domain structure, type taxonomy) is already the correct retrieval mechanism for structured knowledge. A wiki page that is so long it strains context is a wiki hygiene issue, not a retrieval architecture problem.

**Code at scale is better served by the wiki graph, not corpus search.** For coding tasks requiring analysis of many files, the correct approach is to build a wiki that represents the codebase's relationship graph — where functions call, what modules depend on what, which components own which concerns. This is the same distillation strategy applied to code. MCP code-analysis tools that operate at the file level can contribute to this graph. A text-corpus search over raw source does not build the graph and cannot answer relationship questions.

**The tripartite landscape:**

| Text category | Correct retrieval strategy |
|---|---|
| Wiki pages (structured, distilled) | Wiki tools: `wiki_search`, `wiki_read_page`, cross-link graph |
| Small-to-medium external text (fits in context) | Direct context: read it whole, answer directly |
| Large unstructured external text (does not fit) | **RLM**: `web_fetch` results, uploaded documents, data exports |

RLM occupies the third cell — text the system does not control, has not distilled, and cannot restructure. The agent has no wiki to query for that content; the only option is corpus search.

---

### Decision

**RLM (`rlm_query`) must never be used for wiki page retrieval.** It is reserved for unstructured external text that the system does not own:

- `web_fetch` results (live web pages, API responses, documentation fetched on demand)
- User-uploaded documents (PDFs, text files, data exports)
- Any other large text corpus passed into the conversation that has not been distilled into the wiki

The `wiki_read_page(truncate: false)` + `rlm_query` pattern is explicitly discouraged. If a wiki page exceeds the read threshold, the correct response is to fix the wiki (split the page, add cross-links, improve structure) — not to use RLM as a workaround.

The agent system prompt and tool descriptions should make this boundary explicit so the model reaches for RLM only when the corpus is genuinely external and unstructured.

---

### Consequences

- `rlm-002` and `rlm-005` eval scenarios reflect a valid and important case (non-wiki corpus), but the evaluation method needs to account for the structural dynamic where the corpus is visible in context. These scenarios should be restructured or supplemented with cases where the corpus is too large to fit directly — or evaluated on models where context pressure makes delegation the correct choice.
- The wiki upload pipeline and wiki hygiene tooling remain the primary mechanism for keeping wiki pages at a manageable size. Long pages signal a structural problem, not a retrieval problem.
- Future RLM scenarios should focus exclusively on the unstructured-external-text domain. Good candidates: a user pastes a long legal document and asks a specific question about it; the agent fetches a large spec page and must answer a precise technical question; a user uploads a data export and wants a targeted summary.

---

### References

- `docs/Design/RLM.md` — full RLM architecture and design documentation
- `suites/rlm.yaml` — evaluation scenarios, including the ceiling-flagged `rlm-002` and `rlm-005`
- `api/src/agents/tools/rlm-query.tool.ts` — implementation
- PR #47 — initial implementation and auto-eval loop results
