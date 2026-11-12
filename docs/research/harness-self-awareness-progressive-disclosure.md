# Research: Giving the Agent Self-Knowledge of the Harness Without Bloating the System Prompt

Research spanning [issue #334](https://github.com/tkottke90/amazing-hashbrown/issues/334) (Wayfinder Map: Agent-Invocable Skills), [issue #410](https://github.com/tkottke90/amazing-hashbrown/issues/410) (system-prompt context-bloat audit), and [issue #154](https://github.com/tkottke90/amazing-hashbrown/issues/154) (tool-scoped section gating, closed).

## 1. Overview

The agent this harness drives has no durable self-knowledge: no documentation
of how the harness works, or how to use its own capabilities, beyond whatever
a given turn's system prompt happens to say. The project's own design
philosophy (README.md § "Design philosophy: context is scarce") rules out
the obvious fix — "new features that add tools, prompt sections, or other
system-prompt real estate should default to one of \[the\] on-demand patterns
rather than always-on inclusion" — because `buildSystemPrompt()`
(`api/src/agents/system-prompt.ts`, 2,316 lines) is already a measured
problem: issue #410 records a baseline of 9,423–11,900 prompt tokens per turn
before any tool schema or conversation content is counted.

This is a survey for a design discussion, not a recommendation — the same
stance the prior research doc
([`docs/research/issue-244/01-ambient-context-survey.md`](./issue-244/01-ambient-context-survey.md))
takes for a related question. Each finding states what was found, where, and
why; picking among the patterns is a human design call, informed by what
issue #334 has already decided and what issue #410 is asking a research pass
to establish.

## 2. What This Repo's Own Codebase Already Does Today

Four distinct on-demand mechanisms are already live, each covering a
different slice of "the agent knows about and can reach a harness
capability." None of them gives the agent documentation of how the harness
itself works — that specific gap is what issue #334 targets, unimplemented.

### 2.1 `filterHarnessSections()` — tool-scoped prompt sections, gated on binding

`api/src/agents/system-prompt.ts:2096-2222`. `HARNESS_SECTIONS` is an ordered
array of `{ tag, content, requiresAnyOf?, requiresAllOf? }` entries, one per
internal tool group (`wiki_navigation`, `web_fetch`, `rlm`, `shell_execution`,
`search_skills`, `mcp_tool_discovery`, `create_tasks`, `spawn_sub_agent`,
etc.). `buildHarnessPrompt()` always renders every section, because tool
binding isn't known at agent-build time (agents are cached by
provider:model, not by thread — `tool-access.middleware.ts:17-27`).
`filterHarnessSections(prompt, availableToolIds)` is the real per-call
filter, applied by exactly two callers: `tool-access.middleware.ts:171`
(production, the thread's resolved effective tool set) and `bin/eval.ts` via
`lib/evaluations`' `RunConfig` (eval scenarios) — "never a second source of
truth for 'what's available'" (the function's own comment,
`system-prompt.ts:2200-2205`). Sections with no `requiresAnyOf`/
`requiresAllOf` — `identity`, `memory`, `notation` — are never gated; that's
the specific gap issue #410 names (though it also lists `shell_execution` as
ungated, which is no longer accurate: it carries `requiresAnyOf:
['shell_exec']` today, `system-prompt.ts:2149`).

The mechanism was born from a real eval failure (issue #154, closed): with
`wiki_create_page` excluded from the bound schema, the model still reasoned
about calling it because the prompt described it regardless of binding. The
fix direction cited there — "this mirrors the 'just-in-time context' /
context-curation pattern described in Anthropic's 'Effective context
engineering for AI agents'" — is the same source surveyed in §4.2, so this
repo has already anchored this mechanism to that external source once.

**Reach:** purely subtractive — it can only hide text already baked into the
cached prompt string, never teach the agent something new. It answers "stop
describing tools that aren't callable," not "describe a capability only when
relevant." It also never grows the prompt, the exact property issue #334's
acceptance bar requires of any new mechanism.

### 2.2 Skill-Gated Tools, Skill-Scoped Tools, and the Artifact Index

Three mechanisms sharing one piece of state, `activeSkill` (GLOSSARY.md §
Skill Invocation & Runtime Access, ADR-0019):

- **Skill-Gated Tools** (`skill-gated-tools.middleware.ts`, 51 lines) — the
  "composition over customization" example named in root `AGENTS.md`.
  `createSkillGatedToolsMiddleware(registrations)` takes `{ skillCommand,
  toolNames }` entries (`GATED_SKILL_REGISTRATIONS`) and strips a gated tool
  unless the active skill is its registered owner (lines 38-49). Ties one
  tool set to one named skill — the pre-existing shape issue #334 says it is
  not re-deciding.
- **Skill-Scoped Tools** (`skill-scoped-tools.middleware.ts`) — a different
  shape: `read_skill_reference`/`run_skill_script` are visible whenever *any*
  skill is active, resolving "which skill" from state at call time rather
  than a registration (lines 11-24), and injecting the real `activeSkill`
  into `toolCall.args` server-side via a `.passthrough()` schema the model
  never sees declared — "no arbitrary cross-skill file access" enforced by
  construction (lines 25-49).
- **Artifact Index** (`artifact-index.ts`,
  `skill-expansion.middleware.ts:60-65`) — computed fresh from disk on every
  invocation and appended to the skill's body: every current script/
  reference paired with the exact tool call to use it, "never written back
  into `SKILL.md`... so it can't drift from what's actually on disk"
  (ADR-0022).

**Reach:** the closest existing precedent to "teach the agent how to use a
capability only once it becomes relevant" — but scoped entirely to skills a
*human* invoked via `/command` (`skill-expansion.middleware.ts:30-76`); the
agent cannot decide on its own to pull one in. That gap is exactly what
issue #334's `invoke_skill` tool targets.

### 2.3 Search-then-grant discovery: `search_skills` and MCP Tool Discovery

Two instances of one shape, at different scopes:

- **`search_skills`** (`tools/search-skills.tool.ts`) — a single, always-bound
  tool returning only `{ name, slashCommand, description }`, never full
  instructions. `SEARCH_SKILLS_SECTION` (`system-prompt.ts:1866-1871`) is the
  one small, always-on section telling the model when to pass a keyword.
- **MCP Tool Discovery** (issue #408, closed by #415; ADR-0067) generalizes
  the shape to MCP tools. Since #415, MCP tools default to **not bound**
  (`tool-config.ts`'s `resolveToolSettings()`: `defaultInclude.chat: false`
  for `category: 'mcp'`). Two always-on tools replace that default:
  `search_mcp_tools` (keyword → id/name/description, never the schema) and
  `use_mcp_tools` (explicit, turn-scoped grant). `computeDiscoveredToolIds()`
  (`mcp-tool-discovery.ts:31-43`) walks message history back to the last
  human message, unioning every `accepted` id seen — a grant never survives
  into the next Turn. `MCP_TOOL_DISCOVERY_SECTION` is the fixed, small
  always-on text explaining both tools. Issue #408 names its own precedent
  directly: "The app already has a working precedent... `search_skills`...
  MCP tool catalogs have no equivalent today," motivated by #402/#403/#407
  (local-model latency).

**Reach:** the strongest in-repo analog to MCP's own Resources split (§4.1)
and Anthropic's Tool Search Tool (§4.4) — a cheap always-on pointer plus an
on-demand body, model-initiated. But it's scoped to *tool catalogs*, not
*documentation about the harness*. Issue #408 explicitly carves the
recurring/named-workflow case out to a separate mechanism (#409) rather than
solving it here.

### 2.4 LLM Wiki and RLM — the general-purpose retrieval precedents

- **LLM Wiki** (`lib/llm-wiki/`) — "knowledge lives in an on-disk knowledge
  base the agent searches and reads on demand." Its README states what it
  explicitly is not: "No LLM inference... No URL fetching... No UI" — a pure
  mechanical layer (scaffolding, BM25+embedding search, linting) the chat
  agent's `wiki_search`/`wiki_read_page` tools call into. This is the pattern
  issue #334 explicitly excludes: "static app self-documentation stays
  structurally outside \[the wiki\]," citing the AfterAgent misfiling bug
  (#333, open) as the reason its write path can't be trusted with this
  content.
- **RLM** (`lib/rlm/`) — "keep the corpus entirely outside the model, and
  give the model a small set of named read tools." Built for the case where
  "a user's... knowledge base is typically 60–120 thousand characters,"
  beyond an 8B-class local model's ~16–24K character window. Nine REPL tools
  (`peek`, `grep`, `slice`, `summarize`, `query`, etc.); explicitly does no
  corpus assembly, routing, or filesystem access of its own.

**Reach:** both are proven on-demand engines over content the agent already
knows to go looking for. Neither indexes "how this harness works" content
today — RLM has no filesystem access or routing logic by design ("deciding
when to use the retrieval loop... is the application's job"), so reusing it
here would need a new corpus-assembly layer on top, not a change to RLM.

### 2.5 `buildWikiIngestionSystemPrompt()` — a leaner builder, for comparison

`api/src/agents/wiki-ingestion-system-prompt.ts` (88 lines) is a second,
independent builder for the wiki-ingestion surface — five small sections, no
`filterHarnessSections`-style gating, because every section is already
relevant to every turn on that surface. Issue #410 notes this surface (and
the after-agent background calls) is "already much leaner" — a few thousand
tokens vs. 9,400–11,900. This demonstrates the repo already gets an
order-of-magnitude smaller prompt simply by not sharing one builder across
every agent surface, no on-demand machinery required.

### 2.6 Coverage summary

| Mechanism | Teaches the agent... | Model-initiated? | Harness-docs? |
|---|---|---|---|
| `filterHarnessSections` | nothing new (subtractive only) | N/A | No |
| Skill-Gated/Scoped Tools + Artifact Index | a specific skill's tools/files, once invoked | No — human types `/command` | No |
| `search_skills` / MCP Tool Discovery | which skill/MCP tool exists | Yes | No (catalog, not docs) |
| LLM Wiki / RLM | wiki content / a supplied corpus | Yes | Excluded by design (#333) |

No existing mechanism gives the agent model-initiated access to
documentation of the harness itself — exactly what issue #334 names, and it
remains unimplemented.

## 3. What's Already Decided or In-Flight

### 3.1 Issue #334 — the standing destination, still unimplemented

**Open**, `wayfinder:map`, zero sub-issues closed ("Decisions so far" is an
empty comment). Explicitly "a design decision (spec-ready, not yet
implementation)." Fixed points from the issue body:

- Mechanism: a Skill property, a new `invoke_skill` tool, and a per-tool
  `Agent-Exposable` setting — letting the agent fetch a Skill's instructions
  on its own initiative, "without a human typing its `/command`."
- Two pilot domains: **Configuration** and **Workspaces** — app
  self-documentation for end users.
- Explicitly not the LLM Wiki (§2.4; cites #333).
- Claims the mechanism shape is "already decided — see ADR 0011" and that
  terms are pinned in `lib/skills-manager/GLOSSARY.md`. **Both links are
  stale as given**: no `0011-agent-invocable-skills-separate-flag-from-
  tool-gating.md` exists (the real ADR-0011 files are
  `0011-ghost-cell-occupancy-computed-client-side.md` and
  `0011-system-widgets-computed-live-never-persisted.md`, unrelated), and
  `GLOSSARY.md` lives at the repo root, not under `lib/skills-manager/`.
  Noted as a discrepancy only, per the task brief — not corrected here, since
  the right fix (write the missing ADR? repoint the link?) is itself a
  design call.
- Acceptance bar: `system-prompt.ts` does **not** grow (token/line-count
  check), no eval suite regresses, and any new agent-judgment behavior (when
  to call `invoke_skill`) gets eval coverage before merge.
- Not yet specified: whether workspace-authored (`.agents/skills`) Skills
  could ever become Agent-Invocable, and two of five original example topics
  beyond the two pilots.
- Out of scope: "skill-authoring help," closed during grilling since
  `search_skills` already solves that audience's discoverability.

Any proposal here fits inside this already-scoped mechanism (Skill property
+ `invoke_skill` + `Agent-Exposable` flag) or explicitly justifies departing
from it — the issue treats the shape as settled, only the scoping as open.

### 3.2 Issue #410 — the audit this research pass partly answers

**Open**, `enhancement`. States the measured baseline (9,423–11,900
tokens/turn) and that `buildSystemPrompt()` is the shared builder behind
chat, workspace chat, and task-run surfaces, plus the separate
`buildWikiIngestionSystemPrompt()`. Names `filterHarnessSections()` (§2.1) as
covering tool-scoped sections but not `<identity>`/`<memory>`/`<notation>`/
`<shell_execution>` — see §2.1's correction on the last of those. Explicitly
asks for "a research pass on current best practices for harness system
prompts... before deciding what to cut" — this document serves that request.
Lists #402/#403/#407 (§5) as related, and #408 as the already-applied
partial fix for MCP catalog bloat.

### 3.3 Issue #154 — closed, the direct ancestor

Closed. Produced `filterHarnessSections()` (§2.1) from a real eval failure,
and is the issue that first anchored this repo's prompt-trimming work to
Anthropic's "Effective context engineering" (§4.2). Its "Dev Notes" state
the section-to-tool mapping "needs to be built from the same tool-binding
data the LLM client already uses... this shouldn't require a second source
of truth" — a constraint `filterHarnessSections()`'s two real callers still
honor.

### 3.4 Issue #408/#415 as a generalization template

Closed (#408 by PR #415, §2.3). Useful precedent for scoping any future
`invoke_skill`-style work: default-off + two small discovery tools +
turn-scoped grant + a new eval suite (`suites/mcp-tool-discovery.yaml`) added
per EDD. The closing PR is explicit about correcting its own original
premise mid-implementation ("it assumed a discovered tool could reuse
`#tool-name`'s `requestedToolIds` plumbing. It can't... This PR adds new,
separate plumbing instead") — concrete precedent for reading issue #334's own
`invoke_skill`/`Agent-Exposable` sketch as a direction, not a locked API.

## 4. What Primary External Sources Show About This Problem's Shape

### 4.1 MCP spec — Resources: listing vs. reading as the protocol-level split

[modelcontextprotocol.io/docs/concepts/resources](https://modelcontextprotocol.io/docs/concepts/resources)
(2026-07-28). Two distinct JSON-RPC methods: `resources/list` returns only
`{ uri, name, title, description, mimeType, size, icons }` — metadata, never
content; `resources/read` is the separate call returning actual `contents`.
The spec frames this as deliberately **application-driven**, not
model-driven by default: "host applications determin\[e\] how to incorporate
context based on their needs," listing UI pickers, user search/filter, and
"automatic context inclusion, based on heuristics or the AI model's
selection" as three options the protocol leaves open. Resources also carry
optional `annotations.priority` (0.0–1.0) and `annotations.audience`
(`"user"`/`"assistant"`) — a second axis for deciding what surfaces, on top
of the list/read split.

**Relevance:** the cleanest standardized precedent for "cheap always-visible
pointer, expensive on-demand body" as a protocol-level contract — but it does
not assume the model itself decides when to fetch; that's left to the host.
This differs from issue #334's framing of agent self-initiative.

### 4.2 Anthropic — "Effective context engineering for AI agents"

[anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
(already the direct citation behind issue #154). Frames just-in-time
retrieval against upfront loading as a trade-off, not a rule: "runtime
exploration is slower than retrieving pre-computed data," and "the most
effective agents might employ a hybrid strategy." The same section ties
progressive disclosure directly to letting agents explore: they "can
assemble understanding layer by layer, maintaining only what's necessary in
working memory." Separately, under "Tools," it names bloated tool sets as
their own failure mode: "if a human engineer can't definitively say which
tool should be used in a given situation, an AI agent can't be expected to
do better."

**Relevance:** gives the rationale (reduce prefill, avoid selection
ambiguity, build context incrementally) but is model-agnostic guidance, not
a mechanism — it doesn't prescribe *how* a harness should expose
documentation about itself.

### 4.3 Claude Code's own Skills mechanism — the directly analogous system

[code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) —
the mechanism this research agent is itself running inside. Verified
loading-tier language, quoted directly:

- **Always in context:** "skill descriptions are loaded into context so
  Claude knows what's available, but full skill content only loads when
  invoked"; the description is "truncated at 1,536 characters... to reduce
  context usage."
- **Loaded on invocation:** "a skill's body loads only when it's used, so
  long reference material costs almost nothing until you need it"; once
  loaded it "enters the conversation as a single message and stays there
  across later turns" (not re-fed every turn).
- **Supporting files, on demand or executed, never wholesale:** "detailed
  reference material only when needed," scripts "executed, not loaded."
- **Explicit visibility control**, directly analogous to the proposed
  `Agent-Exposable` flag: `disable-model-invocation: true` hides even the
  description, so the model can't decide to invoke it on its own.
- **Named exception:** "Subagents with preloaded skills... the full skill
  content is injected at startup" — no discovery step, since the task is
  already scoped at spawn.
- Cost-aware authoring guidance: "Keep `SKILL.md` under 500 lines," because
  "once a skill loads, its content stays in context across turns, so every
  line is a recurring token cost."

**Relevance:** the closest working precedent to issue #334's proposed shape
— a short always-on pointer the model itself acts on, plus a flag to
suppress model-initiated loading. One structural difference from this
repo's own pattern (§2.3): Claude Code puts every skill's description in
context unconditionally, while this repo's `search_skills` makes even that
listing an on-demand call — one level stricter, likely because this repo
also wants to bound the *count* of always-on descriptions, not just body
size.

### 4.4 Anthropic tool-use docs — definitions vs. results, and the Tool Search Tool

[.../tool-use/overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview),
[.../tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
[.../define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
Baseline split: `name`/`description`/`input_schema` is sent every call
regardless of use; `tool_result` only once a tool is actually invoked.
`define-tools` names description quality, not brevity, as "by far the most
important factor in tool performance... Aim for at least 3–4 sentences" —
directly in tension with minimizing always-on cost, which is why *scaling
the tool count*, not shrinking each description, is where Anthropic's newer
mechanism intervenes.

The **Tool Search Tool** (`tool_search_tool_regex_20251119` /
`..._bm25_20251119`, stable) is Anthropic's own shipped analog of this
repo's MCP Tool Discovery (§2.3): tools marked `defer_loading: true` are
still sent in full on every request (so the server can search them) but
excluded from what Claude's context actually sees until a search returns a
matching `tool_reference`, expanded inline. Anthropic's own numbers: "A
typical multiserver setup... can consume ~55k tokens in definitions before
Claude does any work. Tool search typically reduces this by over 85
percent"; separately, "Claude's ability to pick the right tool degrades once
you exceed 30–50 available tools" — a selection-accuracy failure, not only a
budget one. The docs connect this explicitly back to §4.2: "Tool search's
on-demand loading is also an instance of the broader just-in-time retrieval
principle."

**Relevance:** Anthropic's own confirmation that the search-then-load shape
this repo built independently (§2.3) is the shape Anthropic chose for the
identical problem — strong corroboration the pattern is sound, not a
workaround. Not directly reusable, though: `defer_loading` is a Claude-API
server-side feature with no equivalent for a local Ollama/GLM backend (§5c).

### 4.5 LangChain middleware — the framework this repo's gating sits on

[docs.langchain.com/oss/javascript/langchain/middleware](https://docs.langchain.com/oss/javascript/langchain/middleware)
(official; this repo runs `langchain@1.5.16` /
`@langchain/langgraph@1.4.21`, `api/package.json:15-42`). Middleware hooks run
"before and after each" agent-loop step; "Transforming prompts" and "tool
selection" are listed documented use cases, with a link to a built-in LLM
tool selector. This corroborates this repo's own source comment deferring
MCP relevance to "a future `llmToolSelectorMiddleware` concern" (issue
#154's original text) — the repo's authors already knew LangChain ships a
built-in middleware of that exact name for this exact problem. This repo's
`createMiddleware`/`wrapModelCall` usage throughout
(`skill-gated-tools.middleware.ts`, `tool-access.middleware.ts`,
`mcp-tool-discovery.middleware.ts`) is a documented, first-party extension
point — any `invoke_skill`-style addition plugs into this same chain, no new
infrastructure needed.

## 5. Where This Repo's Constraints Mean an External Pattern Needs Adapting

**(a) Local-model tool-calling reliability is itself in question.** Issue
#402 (closed) found 19/40 logged failures in one real thread were a single
`headersTimeout`-too-short infra bug. Issue #403 (open) found a single
turn's tool-call loop reaching 586,799 tokens against a 32,000-token budget,
with "no mid-turn summarization or pruning" — an `invoke_skill`-style extra
round trip has a context-budget failure mode this repo hasn't solved
generally. Issue #407 (open) found the local Lemonade/GLM-4.7-Flash-GGUF
host itself showing multi-minute stalls consistent with resource contention
or silent CPU fallback. Anthropic's Tool Search Tool and Claude Code's
Skills (§4.3-4.4) both assume a strong, reliable tool-calling model; this
repo's own discovery sections already carry explicit prompt text spelling
out exactly when/how to call the two tools — evidence its authors already
treat local-model self-initiative as needing spelled-out guidance, not
something to assume works out of the box.

**(b) No system-prompt growth, per issue #334's acceptance bar.** Any
pointer-and-expand mechanism modeled on §4.1 or §4.3 still needs *some*
always-on text teaching the model the new capability exists — exactly the
pattern `SEARCH_SKILLS_SECTION`/`MCP_TOOL_DISCOVERY_SECTION` already
demonstrate at a few sentences each, not a documentation dump. That fixed,
small cost has to hold regardless of how much harness documentation ends up
reachable behind it.

**(c) `defer_loading` and MCP's priority annotations are not portable.**
Anthropic's Tool Search Tool is a server-side Claude-API feature with no
equivalent request field for a local backend; this repo's MCP Tool Discovery
necessarily reimplements the same *shape* by hand, in the application layer,
because the underlying protocol feature doesn't exist for a self-hosted
model. Likewise, MCP's `annotations.priority`/`annotations.audience` are
client-side curation metadata nothing in this repo today reads or sets — any
harness-docs mechanism modeled on MCP Resources would need to build that
curation logic itself, not inherit it from the protocol.

## 6. Closing: The Shape of the Open Design Space

A few structurally distinct shapes are visible in what's already proven to
work, without this document picking among them:

1. **Extend the existing search-then-grant shape** (§2.3) from tool catalogs
   to harness-documentation topics — closest to issue #334's own sketch, and
   with a direct eval-suite template (`suites/mcp-tool-discovery.yaml`) to
   copy from.
2. **Lean on Claude Code's unconditional-description-listing model** (§4.3)
   instead — every topic's one-line description always in context, full
   body only on invocation. A larger always-on cost than (1), but closer to
   how Claude Code actually works, and arguably more reliable for a weaker
   local model that might not reliably think to call a search tool first.
3. **Treat it as a client-side curation problem, MCP-Resources-style**
   (§4.1) — the application, not the model, decides which doc topic is
   relevant to a turn and injects it directly, sidestepping whether a local
   model will reliably self-initiate discovery at all.
4. **Extend `filterHarnessSections`'s subtractive gating instead** — treat
   self-knowledge as a continuation of issue #410's audit (make
   `identity`/`memory`/`notation` conditional too) and leave genuinely new
   self-documentation content out of scope until #334 is implemented.

Each answers §5(a)'s reliability question and §5(b)'s token-cost constraint
differently — that trade-off is the open design call, not something this
survey resolves.

## References

**Repo** (read at commit `52767ba`, "On-demand MCP tool discovery instead of
binding full catalogs by default (#415)"):

`README.md` § Design philosophy; `AGENTS.md` § Composition over
Customization; `GLOSSARY.md` §§ Skill Invocation & Runtime Access, MCP
Tooling, MCP Tool Discovery; `api/src/agents/system-prompt.ts`
(`HARNESS_SECTIONS`, `buildHarnessPrompt`, `filterHarnessSections`,
`SEARCH_SKILLS_SECTION`, `MCP_TOOL_DISCOVERY_SECTION`);
`api/src/agents/tool-access.middleware.ts`; `api/src/agents/tool-syntax.ts`;
`api/src/agents/tool-catalog.ts`; `api/src/agents/tool-config.ts`;
`api/src/agents/skill-gated-tools.middleware.ts`;
`api/src/agents/skill-scoped-tools.middleware.ts`;
`api/src/agents/skill-expansion.middleware.ts`;
`api/src/agents/artifact-index.ts`; `api/src/agents/mcp-tool-discovery.ts` /
`mcp-tool-discovery.middleware.ts`;
`api/src/agents/tools/search-skills.tool.ts`;
`api/src/agents/wiki-ingestion-system-prompt.ts`;
`api/src/services/workspace-skills.ts`; `lib/skills-manager/README.md`;
`lib/llm-wiki/README.md`; `lib/rlm/README.md`;
`docs/adr/0022-artifact-index-generated-at-invocation-not-authored.md`;
`docs/adr/0067-mcp-tools-default-off-discovered-per-turn.md`; GitHub issues
[#334](https://github.com/tkottke90/amazing-hashbrown/issues/334),
[#410](https://github.com/tkottke90/amazing-hashbrown/issues/410),
[#154](https://github.com/tkottke90/amazing-hashbrown/issues/154) (closed),
[#408](https://github.com/tkottke90/amazing-hashbrown/issues/408) (closed by #415),
[#415](https://github.com/tkottke90/amazing-hashbrown/issues/415) (merged PR),
[#402](https://github.com/tkottke90/amazing-hashbrown/issues/402) (closed),
[#403](https://github.com/tkottke90/amazing-hashbrown/issues/403) (open),
[#407](https://github.com/tkottke90/amazing-hashbrown/issues/407) (open),
[#333](https://github.com/tkottke90/amazing-hashbrown/issues/333) (open);
`docs/research/issue-244/01-ambient-context-survey.md` (house style
reference).

**External primary sources:**

- MCP spec, Resources (2026-07-28): https://modelcontextprotocol.io/docs/concepts/resources
- Anthropic — "Effective context engineering for AI agents": https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude Code docs — Skills: https://code.claude.com/docs/en/skills
- Anthropic — Tool use overview: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic — Define tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Anthropic — Tool Search Tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- LangChain — Middleware (JS/TS docs): https://docs.langchain.com/oss/javascript/langchain/middleware

## Caveat

The LangChain "custom middleware" page that would show the exact
`wrapModelCall`/`createMiddleware` API contract (vs. the higher-level
overview actually fetched, §4.5) 404'd at the guessed URL
(`docs.langchain.com/oss/javascript/langchain/custom-middleware`). §4.5's
claim rests on the overview page's listed use cases and named tool-selector
link, not a direct quote of `wrapModelCall`'s contract — that narrower point
rests instead on this repo's own source comments (which cite the exact
LangChain version and describe empirical verification of the hook's
behavior, e.g. `tool-access.middleware.ts:17-27`), not an official LangChain
page confirmed in this pass.
