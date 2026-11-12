# Research: A Q&A-Over-Documentation Tool as a System-Prompt-Size Lever

A direct, narrower follow-up to
[`docs/research/harness-self-awareness-progressive-disclosure.md`](./harness-self-awareness-progressive-disclosure.md)
(read first — this document cross-references it rather than repeating its
content) — itself spanning [issue #334](https://github.com/tkottke90/amazing-hashbrown/issues/334)
(Wayfinder Map: Agent-Invocable Skills) and [issue #410](https://github.com/tkottke90/amazing-hashbrown/issues/410)
(system-prompt context-bloat audit, "in the spirit of" which this question is
framed).

## 1. The question, restated precisely

Would a tool/skill the agent calls to ask a natural-language question against
a documentation corpus — getting back a **synthesized answer**, not the raw
document text — help shrink this repo's system prompt, in exchange for the
agent sometimes needing an extra round trip before it can act (the
just-in-time / gating model)? This is narrower than the prior document's
survey: it isolates one specific shape (model asks a question, gets an
answer) and asks what it costs and where it fits.

This stays a survey for a design discussion, per the prior document's own
stated convention — it states what was found and why, not what to build.

## 2. This repo already has the engine; it just points the wrong way for this job

**What exists today, precisely:** `lib/rlm/` — the Retrieval Loop Model
library — already named in this repo's README "Design philosophy: context is
scarce" section as one of the three existing on-demand patterns, and already
bound as a live LangChain tool, `rlm_query`
(`api/src/agents/tools/rlm-query.tool.ts:150-219`). Its own README states the
user's exact proposal back almost verbatim: "keep the corpus entirely outside
the model, and give the model a small set of named read tools... The model
loops through these tools, retrieving only the fragments it needs, until it
has enough to answer. It never sees the full corpus." (`lib/rlm/README.md:9`).
It already returns a synthesized answer, not raw passages — `rlmQueryTool`'s
handler returns `result.answer` (plus a short termination/iteration-count
footer), never the corpus text itself (`rlm-query.tool.ts:195-208`).

**What's missing, precisely:** the `corpus` field is caller-supplied, not
fixed. The Zod schema's own description says the model must "Obtain from
wiki_read_page with truncate: false, or from any other large text source such
as web_fetch" (`rlm-query.tool.ts:18-24`). So today, asking a question "about
the harness" through this tool requires the model to first fetch the full
harness-docs text through some *other* tool call, then pass it as `corpus` —
a two-hop dance, not the one-call "ask and get an answer" shape the question
describes. There is no fixed, pre-selected harness-documentation corpus
`rlm_query` (or anything else) points at.

**What binding `rlm_query` already costs the system prompt, as a concrete
baseline.** Two pieces, both gated on the tool actually being bound
(`filterHarnessSections`, covered in the prior document §2.1):

- `RLM_SECTION` (`api/src/agents/system-prompt.ts:1175-1197`), gated
  `requiresAnyOf: ['rlm_query']` (`system-prompt.ts:2148`) — 1,708 characters
  (measured directly from the source constant), roughly 425 tokens by a
  chars÷4 rule of thumb (an estimate, not an actual tokenizer count — no
  tokenizer was run for this document).
- The tool's own schema text — `description` plus the `question` and
  `corpus` field descriptions — totals 503 characters (~125 tokens by the
  same rule of thumb), sent as part of the tool's JSON-schema definition on
  every turn `rlm_query` is bound, per Anthropic's own tool-use docs: "name,
  description, input_schema is sent every call regardless of use" (cited in
  the prior document §4.4, platform.claude.com `tool-use/overview`).

So today's "cost of one Q&A-shaped tool" is roughly 550 tokens of combined
always-on text (by the rough estimate above) whenever it's bound — small
relative to the 9,423–11,900-token baseline issue #410 measured
(prior document §3.2), but not zero, and it buys *zero* harness-doc content
living in the prompt as the trade.

**Why `RLM_SECTION` is this long and this specific, and what that implies
for a new variant.** The section's own authorship comments
(`system-prompt.ts:1134-1174`) record three rounds of auto-eval tightening
against real model failures — models answering a visible corpus directly
instead of delegating, misusing `wiki_search` as if it searched within a
page, and (after ADR-001, §3 below) conflating RLM with wiki retrieval. A
harness-docs-pointed variant would need its own round of exactly this kind of
eval-driven prompt tightening (this repo's `AGENTS.md` Evaluation-Driven
Development rule 1 requires a failing eval scenario before implementation
regardless) — the 1,708-character section is not incidental bulk; it is the
accumulated cost of making a Q&A-shaped tool's triggering condition reliable
on real local models, and a new corpus would likely need a comparably-sized
section of its own, not a trivial one-liner.

## 3. What changes if a tool pointed at a *fixed* harness-docs corpus instead

**The round trip removed:** today's `rlm_query` needs the calling model to
fetch the full corpus itself first (§2). A tool bound to a fixed corpus —
whether a new tool, or a `rlm_query` variant with the `corpus` parameter
removed and the text supplied server-side — collapses that to one call:
schema is just `{ question: string }`, with the harness-docs text assembled
once outside the model and handed straight to `RLMRunner.run()`
(`lib/rlm/README.md:40-45` shows this exact one-corpus-literal call shape).
This is a genuine, measurable win over today's two-hop shape for this
specific use case: one fewer tool-call round trip, and the `corpus`
field's own description text (about half the 503-character schema total,
§2) drops out of the schema entirely.

**What it costs that `rlm_query` doesn't today:** RLM's own README is
explicit that it does none of this by design — "No corpus assembly. You pass
a plain string. What text goes in it, and how it's concatenated, is your
responsibility" (`lib/rlm/README.md:23`). A fixed-corpus variant needs a new
assembly layer (which files, concatenated how, kept in sync with what) that
doesn't exist yet and isn't RLM's job to provide — RLM's own list of what it
explicitly does *not* do already rules this out as a library-level concern
(`lib/rlm/README.md:20-26`).

**What it costs at call time, every time it's actually used — this is the
part the brief's framing ("JIT model or gating idea") doesn't account for:**
`rlm_query`'s internal loop is not one model call. `RLMConfig.maxIterations`
defaults to 10 (`lib/rlm/docs/api-reference.md` — `RLMConfig` table,
`maxIterations` row; same default echoed in `api/src/config/env.ts:432`,
`RLMConfigSchema`). Each iteration is a full model-inference round trip
through whatever provider `env.rlm` resolves to — and per
`rlm-query.tool.ts:152-154`, that provider/model is independently
configurable from the main chat model via `createProvider(rlmConfig.provider,
resolvedModel)`. PR #414 ("Add provider/model picker UI for rlm_query tool
settings", commit `fda9e25`) added a UI specifically for choosing a *different*
provider/model for `rlm_query`'s internal loop than whatever is driving the
main chat turn (`git show fda9e25 -- ui/src/components/tool-settings-drawer.tsx`
adds a `useProviderModelPicker` picker wired to `patch.provider`/`patch.model`
on the `rlm_query` tool setting). So the real cost of "the agent asks a
question" here is not bounded by the small schema in the main system
prompt — it's up to 10 separate inference calls against a provider that
could be a larger remote model, each with its own latency and (if remote)
token cost, entirely outside the main turn's context-window accounting. This
is the opposite cost shape from Claude Code's Skills mechanism (prior
document §4.3): loading a skill body is one synchronous context injection,
not an inner agentic loop.

## 4. ADR-001 already drew the exact line this proposal would cross

This is the single most load-bearing primary source for whether "point RLM
at harness docs" is even the right extension point, and it already exists in
this repo: `docs/ADR.md`, **ADR-001: RLM and LLM Wiki Serve Distinct,
Non-Overlapping Domains** (accepted 2026-08-04).

ADR-001's own tripartite table (`docs/ADR.md:50-58`):

| Text category | Correct retrieval strategy |
|---|---|
| Wiki pages (structured, distilled) | Wiki tools: `wiki_search`, `wiki_read_page`, cross-link graph |
| Small-to-medium external text (fits in context) | Direct context: read it whole, answer directly |
| Large unstructured external text (does not fit) | **RLM**: `web_fetch` results, uploaded documents, data exports |

Its stated rationale: "The wiki is already distilled. Wiki pages are
structured, summarized, cross-linked knowledge — the output of a deliberate
distillation process. Using RLM to extract targeted answers from wiki pages
would re-extract from already-extracted content: doing the work twice."
(`docs/ADR.md:46`). The Decision section is explicit and absolute: "RLM
(`rlm_query`) must never be used for wiki page retrieval. It is reserved for
unstructured external text that the system does not own" (`docs/ADR.md:64`).

**This repo's own harness documentation (AGENTS.md files, `docs/ADR.md`
itself, `lib/*/README.md`, `docs/Design/*.md`) is structured, maintained,
version-controlled markdown — the system's own authored content, not
unstructured external text the system doesn't own.** By ADR-001's own
stated criterion, it sits in the first row of that table (structured,
distilled, system-owned), not the third (RLM's row). Pointing `rlm_query`
or an RLM-style raw-corpus-search tool at harness docs would be, by this
ADR's own stated logic, the same category error it already ruled out for
wiki pages — doing retrieval-by-corpus-search over content that is already
organized, cross-linked, and could instead be served through a structured
lookup. This doesn't mean the idea is wrong; it means the ADR's own
reasoning points toward extending the *wiki-tools/search-then-grant* shape
(prior document §2.3: `search_skills`, MCP Tool Discovery) rather than the
*RLM* shape for this specific content category — which is exactly the shape
issue #334 (§5 below) already proposes.

One caveat on reusing ADR-001's eval findings directly: ADR-001's
ceiling-flagged finding — models answering from a corpus already visible in
context instead of delegating to `rlm_query` (`docs/ADR.md:31-38`) — assumes
the corpus is already present in the conversation. A fixed harness-docs
corpus bound server-side would *never* be in context by default (that's the
entire point of keeping it out of the system prompt), so that specific
failure mode cannot occur the same way here. But a related, arguably worse
failure mode can: with no competing visible text to answer from, a model
that skips the tool doesn't fall back to a *correct* answer it can already
see (ADR-001's finding was that the model's unprompted behavior was actually
fine) — it falls back to an *unfounded* one, i.e. it may answer a question
about the harness from training-data assumptions or stale memory instead of
asking. ADR-001's finding that "the ceiling is architectural, not a
calibration issue" (`docs/ADR.md:38`) doesn't straightforwardly transfer; the
structural conditions differ.

## 5. The "ask first" risk: what forces a tool call, and what this repo has already hit

**Primary-source mechanism for compelling a tool call: `tool_choice`.**
Anthropic's own docs (`platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools`,
"Forcing tool use" section, fetched 2026-11-12) define four `tool_choice`
modes: `auto` (default — the model decides), `any` ("must use one of the
provided tools, but doesn't force a particular tool"), `tool` ("forces Claude
to always use a particular tool"), `none`. This is the actual mechanism for
*compelling* a specific tool call before a reply, as distinct from describing
a tool and hoping the model reaches for it.

**That mechanism is not universally available, including on current Claude
models — and this repo has already hit the failure mode directly.** The same
page states plainly: "Not every model and setting supports forced tool use.
Where it isn't supported, `tool_choice: {"type": "any"}` and `tool_choice:
{"type": "tool", "name": "..."}` fail." Its restriction table names
**Claude Fable 5.2, Mythos 5.2, Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos
5.1** as returning a 400 on `any`/`tool`, recommending `auto` with strict
tool use or structured outputs instead. This repo's own design doc,
`docs/superpowers/specs/2026-10-21-anthropic-forced-tool-choice-and-stream-content-blocks-design.md`,
documents hitting exactly this: `AfterAgent`'s `invokeStructured()`
(`api/src/agents/after-agent.ts:295-307`) and — directly relevant here —
**`rlm-adapter.ts:42`, the same `LangChainInferenceAdapter.invoke()` that
backs `rlm_query`'s own internal loop**, both call
`withStructuredOutput(schema)` with no `method` override, which defaults to
forcing `tool_choice`, which the doc confirms "all four of AfterAgent's
structured calls" hit with the exact documented 400 ("tool_choice: type
\"tool\" and \"any\" are not supported for this model."), fixed by switching
to `{ method: 'jsonSchema' }` to route through each provider's native
structured-output surface instead of a forced tool call
(design doc lines 76–175). **The mechanism this proposal's "ask first" step
would lean on hardest — forcing a tool call — is the exact mechanism this
repo's own RLM machinery had to stop relying on**, on the model family most
likely to be used as the configured judge/retrieval model for `rlm_query`
per §3's provider-picker finding.

**Ollama — this repo's actual local-model provider — has no forced
tool-choice field at all, confirmed against the current official docs.**
Ollama's official API reference (`raw.githubusercontent.com/ollama/ollama/main/docs/api.md`,
fetched 2026-11-12) documents `tools` as a request parameter and `tool_calls`
as an optional response field, with tool use framed entirely as something
the model decides to do; the term `tool_choice` does not appear anywhere in
the document, and no parameter for requiring a specific tool is documented
for `/api/chat`. Ollama's own "Tool support" announcement
(`ollama.com/blog/tool-support`) lists "Tool choice: force a model to use a
tool" under **Future improvements** — i.e. not yet shipped at the time of
that post, consistent with the current API docs still showing nothing.
Because this repo's providers are Ollama (local), OpenAI-/Azure-OpenAI-
compatible (`provider-factory.ts:177-220`), and Anthropic, and the one
family of these that does define forced `tool_choice` (Anthropic) now
actively rejects it on current models (above), **there is today no reliable
API-level way to compel this harness's agent to call a Q&A tool before
replying** — the "ask first" step can only ever be optional (`auto`), hoped
for via prompt text, exactly the status quo this repo's other discovery
mechanisms (`search_skills`, MCP Tool Discovery) already live with (prior
document §2.3, §5a).

**What this repo's own RLM work already learned about getting reliable
behavior without forced tool-choice.** `docs/Design/RLM.md` documents the
exact "model skips the step it should take" failure this proposal risks, and
how it was addressed — not through an API-level forcing mechanism (which, as
above, doesn't exist for this repo's providers), but through *structural
tool design*: "Structural refusal (`not_found` tool) is the single
highest-leverage honesty mechanism: restores 10/10 honesty on qwen3:8b
without retrieval cost. Refusal must be a first-class tool, not a prompt
instruction." (`docs/Design/RLM.md:41`). Elaborated later in the same
document: "prompt-only honesty instructions are unreliable under retrieval
pressure regardless of model size... the presence of the tool in the schema
is what matters, not whether the model calls it on every absent case. POC-002
finding: qwen3:8b went from 6/10 honest to 10/10 honest purely by adding the
`not_found` tool, without any change to prompt instructions or retrieval
scaffolding." (`docs/Design/RLM.md:373`). The same document also names a
harness-level (not API-level) fix for the specific "model answers without
asking" failure mode: "For absence-heavy workloads, forced-search-first
routing is the correct scaffold response" (`docs/Design/RLM.md:42`) — i.e.
the harness can still make a retrieval step effectively mandatory by not
exposing the choice to skip it as a live option in the first place
(application-level routing), rather than depending on a provider's
`tool_choice` guarantee. This is this repo's own closest primary-source
precedent for how the "ask first" risk gets managed in practice here, and it
predates (and doesn't depend on) this specific proposal.

**How this interacts with the optional-vs-forced framing in the brief.** A
model that is merely *invited* to call a Q&A tool (the realistic option,
given §5's provider findings) can skip it two ways: correctly (it already
knows the answer and the tool would be redundant — the benign case ADR-001's
own eval findings describe, §4) or incorrectly (it answers from a wrong
assumption instead of checking — the risky case, worse here than in
ADR-001's finding because, per §4's caveat, there's no visible corpus to
fall back on correctly). Issue #403 (open; cited in the prior document §5a)
already shows this repo's tool-call loops can run far outside their declared
budget (586,799 tokens against a 32,000-token budget in one real turn) with
"no mid-turn summarization or pruning" — evidence this repo's own tool-call
loops are not yet robust to a model behaving unpredictably around an
optional extra step, independent of this specific proposal.

## 6. Relation to issue #334 — simpler variant, complement, or orthogonal?

Per the prior document (§3.1), issue #334 is open, spec-ready-not-implemented,
and already commits to a specific shape: a Skill property, a new
`invoke_skill` tool, and a per-tool `Agent-Exposable` setting, letting the
agent fetch a Skill's instructions on its own initiative. Its acceptance bar
is that `system-prompt.ts` does not grow.

This proposal — a tool that answers a question against a fixed harness-docs
corpus — is not a duplicate of #334's mechanism, but per §4's ADR-001
analysis, it targets the *same content category* (structured, system-owned
documentation) that #334 already claims, via a different retrieval shape
(answer-synthesis-over-raw-text-search, §2) rather than #334's
(inject-the-skill's-own-instructions-verbatim). Three ways this could relate,
without this document picking among them:

1. **A retrieval strategy *underneath* `invoke_skill`, not a competing
   mechanism.** If #334 ships `invoke_skill`, nothing about its spec commits
   it to injecting a Skill's full body verbatim — it could instead run an
   RLM-style loop over that Skill's documentation and return a synthesized
   answer to the specific question the model had, when the Skill's reference
   material is long. This reuses #334's already-decided plumbing
   (`Agent-Exposable` flag, the tool itself) and only changes what happens
   inside it for long reference bodies — closer to "complement" than
   "alternative."
2. **A narrower, cheaper step that could land *before* #334**, since it
   needs none of #334's new machinery (no new Skill property, no
   `Agent-Exposable` flag, no `invoke_skill` tool) — just one new bound tool
   over one fixed, assembled corpus. Simpler to build, but per §4, it's the
   shape ADR-001's own reasoning argues against for this content category,
   and per §2, it would need its own eval-driven prompt-tightening pass
   before it could be trusted to trigger reliably (`AGENTS.md`'s EDD rule 1).
3. **Orthogonal if #334's pilot domains stay Configuration and
   Workspaces** (prior document §3.1) rather than the harness's own
   documentation — in which case this proposal addresses a gap #334 was
   never scoped to close in its first iteration, and the two could proceed
   independently.

## References

**Repo** (read at commit `b89fd03`, "Add research on harness self-awareness
without system-prompt bloat"):

`README.md` § Design philosophy; `lib/rlm/README.md`;
`lib/rlm/docs/api-reference.md` (`RLMConfig`, `maxIterations`);
`docs/Design/RLM.md` (lines 39–42, 369–382); `docs/ADR.md` (ADR-001, lines
7–91); `api/src/agents/tools/rlm-query.tool.ts`;
`api/src/agents/system-prompt.ts` (`RLM_SECTION`, lines 1134–1197;
`filterHarnessSections` gating, line 2148); `api/src/config/env.ts`
(`RLMConfigSchema`, lines 431–452); `api/src/services/provider-factory.ts`
(lines 150–220); `api/src/agents/after-agent.ts`;
`docs/superpowers/specs/2026-10-21-anthropic-forced-tool-choice-and-stream-content-blocks-design.md`;
git commit `fda9e25` ("Add provider/model picker UI for rlm_query tool
settings (#414)"); GitHub issues
[#334](https://github.com/tkottke90/amazing-hashbrown/issues/334),
[#410](https://github.com/tkottke90/amazing-hashbrown/issues/410),
[#403](https://github.com/tkottke90/amazing-hashbrown/issues/403) (open);
[`docs/research/harness-self-awareness-progressive-disclosure.md`](./harness-self-awareness-progressive-disclosure.md)
(direct prior document, cross-referenced throughout rather than repeated).

**External primary sources:**

- Anthropic — Define tools, "Forcing tool use" (`tool_choice` modes and the
  per-model restriction table): https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
  (fetched 2026-11-12)
- Ollama — API reference (no `tool_choice` field documented for
  `/api/chat`): https://github.com/ollama/ollama/blob/main/docs/api.md
  (fetched 2026-11-12)
- Ollama — "Tool support" blog post (`tool_choice`/forced tool use listed
  under "Future improvements," not shipped at time of writing):
  https://ollama.com/blog/tool-support
- Anthropic — "How we built our multi-agent research system" (subagents as
  "intelligent filters" returning condensed results, not raw search
  material, to bound the parent's context):
  https://www.anthropic.com/engineering/built-multi-agent-research-system

## Caveat

The Ollama blog post's "Future improvements" framing is undated in the
fetched excerpt — it is treated here as corroborating, not sole, evidence for
"Ollama has no forced tool choice today," with the current official API
reference (`docs/api.md`, fetched the same day) as the primary claim-bearing
source; the two agree. Whether `@langchain/ollama` (the pinned LangChain
wrapper this repo actually calls, `provider-factory.ts:177-200`) exposes a
`tool_choice`-shaped constructor or call option that it silently drops or
errors on against a real Ollama server was not independently verified in
this pass — no local `node_modules` install of the package was available to
inspect, and no official LangChain JS page for `ChatOllama`'s exact bound-
tools call shape was fetched. This doesn't change the conclusion (Ollama's
own server has nothing to honor such an option with), but it is a
secondary-sourced gap in this specific sub-claim, flagged per the task's
sourcing standard.
