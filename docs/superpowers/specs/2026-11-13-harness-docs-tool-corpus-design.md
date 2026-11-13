# Harness Documentation Lookup Tool — Backing Corpus Design

**Date:** 2026-11-13
**Status:** Draft
**Related:** [Issue #416](https://github.com/tkottke90/amazing-hashbrown/issues/416) (the tool this corpus backs), [Issue #334](https://github.com/tkottke90/amazing-hashbrown/issues/334) (rescoped away from this content), [Issue #410](https://github.com/tkottke90/amazing-hashbrown/issues/410), [Issue #333](https://github.com/tkottke90/amazing-hashbrown/issues/333). Research: `docs/research/harness-self-awareness-progressive-disclosure.md`, `docs/research/docs-qa-tool-jit-retrieval.md`, `docs/research/read-only-harness-wiki-vs-dedicated-tool.md`.

---

## Goal

Settle the one Design Need issue #416 left open: what corpus backs the harness-documentation lookup tool, how it's searched, and how it's built and kept in sync. Everything else about the tool (single-call shape, 10K-char response budget, no RLM, no system-prompt growth beyond one section) was already decided when #416 was opened — this spec covers the corpus only.

## Problem

Three prior research passes ruled out the two obvious alternatives for giving the agent self-knowledge of the harness: an RLM-backed Q&A tool (ADR-001 already reserves RLM for unstructured, system-external text — this app's own docs are structured and system-owned) and a new read-only LLM Wiki domain (no existing write-guard makes a domain permanently read-only, and a harness-docs domain would be an unusually strong Domain-Fit-Score magnet for the exact kind of misfiling issue #333 already hit). That left "build a dedicated tool" as the settled direction, with the corpus itself as an open question. This spec is the result of grilling that question directly.

---

## Decisions (settled via grilling)

| Question | Decision |
|---|---|
| Content scope | Reference/terminology questions only ("what is X"). Tool-usage guidance ("when should I use X") stays exclusively in each tool's own eval-tuned system-prompt section — never duplicated into this corpus, to avoid a second, independently-drifting copy of text that's already been through multiple rounds of failure-driven tightening. |
| Audience boundary | User/agent-facing content only. Developer-facing docs (`AGENTS.md`, `lib/*/README.md`, ADRs) are excluded — they're written for someone editing this codebase, not someone using the app. |
| v1 sources | `GLOSSARY.md` (repo root) and `docs/App-Docs/*.md`. Both already exist; no new hand-authored content for v1. |
| `docs/App-Docs` status | **Legacy, reference-only.** `configuration.md` documents only 5 of the ~23 top-level sections in the real config schema (`embeddings`, `database`, `observability`, `afterAgent`, `chat` — missing `roles`, `skills`, `tasks`, `tools`, `workspaces`, `loopGuard`, `trackers`, and more) and has had one commit since it was added. It is indexed as-is for whatever it covers; no work goes into expanding or fixing it as part of this effort. |
| Official documentation platform | **Out of scope for this corpus — a separate initiative.** A new location for managing official documentation (format, hosting, and ideally also driving a human-facing doc site) is its own open design question, tracked as a new Wayfinder Map issue, not decided here. This corpus migrates to that platform's output once it ships; it does not block on it now. |
| `GLOSSARY.md` scope | Indexed in full. No pre-filtering of entries that read as internal pipeline mechanics (e.g. Domain Fit Score, Trusted Commit Band) — that's deferred until an eval run actually shows a bad answer, not engineered pre-emptively. |
| Search engine | A standalone `LlmWiki` instance (`@tkottke90/llm-wiki`'s `LlmWiki` class) — **never registered with `WikiRegistry`**. `wiki_search`, `wiki_locate`, and AfterAgent never see or write to it. This sidesteps the cross-domain fog risk and the misfiling risk from the wiki research entirely, since this corpus never shares retrieval space with the real wiki. |
| Search ranking | Real hybrid BM25 + embedding search, via `LlmWiki.semanticSearch()`, using this repo's existing `EmbeddingAdapter` abstraction (`api/src/services/rlm-embedding-adapter.ts` — the same one `rlm_query` and the real wiki already use). Not keyword-only — a plain keyword matcher has gaps when a question doesn't use the corpus's exact terms. |
| Embedding availability fallback | Degrades to keyword-only when no embedding provider is configured (or it's unreachable) — the same fallback `semanticSearch` already has today ("Omit to fall back to keyword-only search"). No new failure mode introduced. |
| Chunking granularity | One page per bolded term entry in `GLOSSARY.md` (fine-grained — "Widget," "Wiki Domain," "Self" each their own page); one page per `##`/`###` heading in `App-Docs` (its natural topic unit). Chosen over one page per top-level `#` section so a query can return 2-3 precise hits under the 10K-char response budget instead of one coarse block dragging in unrelated terms from the same section. |
| Provenance | Free via `PageFrontmatter.sources` (`lib/llm-wiki/src/types.ts`) — populated at build time with the source file/heading each page was chunked from. No new field needed. |
| Build vs. runtime split | Content chunking (splitting `GLOSSARY.md`/`App-Docs` into page-shaped input) happens at build time. Embedding *vectors* are computed at runtime (server startup or first query), against whichever embedding provider the deployed install is actually configured with — a build server has no way to know that in advance, and `EmbeddingIndex.load(basePath, provider.model)` already keys its cache to the provider/model actually in use. |
| Build integration | One script, invoked by both `api`'s `build` (`tsc -p tsconfig.json`) and `dev` (`tsx watch src/index.ts`) — neither path ever runs without a current index. `build` bakes the index into the release (so each shipped version has reference docs as of that release); `dev` regenerates from current source on every start. |

---

## Architecture

### 1. Corpus assembly — a build-time script

A new script (e.g. `api/scripts/build-harness-docs-index.ts`) runs before both `build` and `dev`:

1. Parses `GLOSSARY.md` (repo root), splitting on each bolded term entry (`**Term**:` ... up to the next such entry) into one page-input per term. The enclosing `# Section` / `## Language` heading becomes a `tags` entry on that page; the term itself becomes `title`.
2. Parses each file under `docs/App-Docs/*.md`, splitting on `##`/`###` headings into one page-input per heading section.
3. Writes `sources: [<file>#<heading-or-term>]` into each page's frontmatter — this is what makes an answer traceable back to the real doc without any new plumbing (`PageFrontmatter.sources` already exists for exactly this).
4. Commits the resulting pages into a dedicated `LlmWiki` instance at a path outside `wikiRoot` (so it is structurally distinct from any install's real wiki data and never discoverable through `WikiRegistry.list()`).

This step does no network I/O and needs no credentials — it's pure text splitting, consistent with embedding computation staying out of the build.

### 2. The lookup tool itself

Defined by issue #416, unchanged by this spec: a single-call tool taking a question/keyword, calling the standalone `LlmWiki` instance's `semanticSearch()` directly (not through any wiki-facing tool or middleware), and returning the top-ranked page(s) — capped so the combined response stays under `STUB_THRESHOLD_CHARS` (`api/src/agents/tools/tool-stub.ts`) and never trips the `get_tool_key` offload path.

### 3. Runtime loading

At server startup, the API loads the pre-built `LlmWiki` instance once (`LlmWiki.load`), the same way it would load any wiki — but this instance is held only by the new tool's own module, never passed to `WikiRegistry`, `wiki_search`, `wiki_locate`, or the AfterAgent pipeline. The first call to `semanticSearch()` (or the first one that needs the embedding index) builds/loads the embedding cache against this install's actual configured provider; later calls reuse it.

### 4. What's explicitly deferred

- **Official documentation platform.** A new Wayfinder Map issue, not written here, covers format/location/tooling for managing official docs long-term, plus a stretch goal of generating a human-facing documentation site from the same source. This corpus's `App-Docs` source is expected to be replaced by that platform's output once it ships.
- **`docs/App-Docs` coverage gap.** Not fixed as part of this effort. The lookup tool will correctly return "no answer found" for the ~75% of config schema it doesn't cover today — safe, but worth the team knowing it's a docs-content gap, not a tool bug, when it comes up.
- **Per-term filtering of `GLOSSARY.md`.** Not built for v1. Revisit only if an eval run shows the tool surfacing an internal-mechanics term (e.g. Domain Fit Score) in a confusing way.
