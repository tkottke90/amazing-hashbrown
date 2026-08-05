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

| Text category                                   | Correct retrieval strategy                                     |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Wiki pages (structured, distilled)              | Wiki tools: `wiki_search`, `wiki_read_page`, cross-link graph  |
| Small-to-medium external text (fits in context) | Direct context: read it whole, answer directly                 |
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

---

## ADR-002: Agent Skills Slash Commands Are Expanded at LLM Call Time, Not Chat Time

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** Engineering

---

### Context

During design of the Agent Skills (slash commands) feature, a foundational pipeline question arose: when a user sends a message beginning with `/skill-name args`, at what point in the system does the slash command get replaced with the skill body from `SKILL.md`?

Two options were identified:

**Option A — Expand at chat time (in `streamChatToSse`):**
The incoming message content is intercepted in `stream-handler.ts` before the agent is invoked. The `/skill-name args` string is replaced with the full skill body + args, and this expanded content is what gets passed to `agent.streamEvents()` and stored in the LangGraph checkpoint.

**Option B — Expand at LLM call time (via `messageModifier`):**
The message is stored in the checkpoint as-is (`/skill-name args`). LangGraph's `createReactAgent` `messageModifier` callback intercepts the messages array immediately before the LLM is called, detects any slash command in the most recent human message, and replaces it with the expanded skill body + args. The checkpoint is never modified.

---

### Research: AgentSkills Specification Guidance

The AgentSkills specification (agentskills.io) defines two activation mechanisms:

**Model-driven activation** (the spec's primary mechanism):

> "Most implementations rely on the model's own judgment as the activation mechanism, rather than implementing harness-side trigger matching or keyword detection. The model reads the catalog [...], decides a skill is relevant to the current task, and loads it."

In this path the model calls an `activate_skill` tool or reads the file directly. The skill content arrives as a tool result and is naturally stored in conversation history. The spec explicitly advises: _"Flag skill tool outputs as protected so the pruning algorithm skips them."_

**Harness-side slash command activation:**

> "The most common pattern is a slash command or mention syntax (`/skill-name` or `$skill-name`) that the harness intercepts. The specific syntax is up to you — the key idea is that the harness handles the lookup and injection, so the model receives skill content without needing to take an activation action itself."

**The specification is entirely silent on whether the harness-side path should expand before or after checkpointing.** It does not prescribe what the conversation history contains — the original slash command or the expanded body. This is left as an implementation detail. The only history guidance in the spec (protect skill content from pruning) applies exclusively to the model-driven tool-call path, not the harness-side path.

The spec describes both activation mechanisms as equivalent: _"Both approaches work in practice."_

---

### Analysis

The two options have meaningfully different properties:

| Dimension                 | Option A (chat time)                         | Option B (LLM call time)                                            |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Checkpoint stores         | Full skill body + args                       | `/command args` (original)                                          |
| Thread history UI         | Skill body visible (noisy)                   | `/summarize my notes` (clean)                                       |
| Fork / retry              | Re-sends old (possibly stale) skill body     | Re-expands against current skill                                    |
| Skill updated mid-thread  | Prior messages embed old body                | All invocations use current skill                                   |
| Multi-turn behaviour      | Skill body in context once                   | Only injected when the invoking message is the latest human message |
| Skill-not-found error     | Caught before agent starts — easy to surface | Caught inside modifier — requires careful SSE error routing         |
| Implementation complexity | Low                                          | Medium                                                              |

The spec's history guidance points toward skill content living in the record (aligned with Option A), but that guidance was written for the model-driven tool-call path where the content arrives as a tool result with full provenance. The harness-side injection path is structurally different: there is no tool invocation to hang the content on, so storing the full body in the checkpoint adds bulk with no structural benefit.

A key concern with the naive form of Option B — injecting the skill body on every LLM call regardless of message position — is that it would re-send the full skill instructions on every subsequent turn in the thread, even for follow-up messages that have nothing to do with the original invocation. This wastes context and misleads the model about which instructions apply to the current request.

---

### Decision

**Option B is adopted, with a latest-message-only constraint.**

A pre-LLM message transform hook in `createAgent` inspects the messages array before each LLM call and expands a slash command **only if it appears in the most recent human message.** Historical messages in the thread that contain slash commands are passed through as literal text — they are not re-expanded. This ensures:

1. The checkpoint stores the user's original intent (`/command args`), keeping conversation history readable and compact.
2. The model receives the expanded skill body exactly once, attached to the message that invoked it, with no ambiguity about which instructions govern the current request.
3. Skill updates take effect immediately — a re-invocation in a new message uses the current `SKILL.md` body.
4. Forked or retried threads re-expand against the live skill definition rather than a stale embedded copy.

The latest-message-only constraint is the core invariant: if the skill command is not in the final human message, the modifier is a no-op.

---

### Consequences

- The pre-LLM transform closes over the `SkillsManager` singleton, which must be booted before the agent is built. Skill-not-found errors surface as a modified message with an inline error notice rather than a pre-flight SSE error; error handling must be robust.
- Historical thread messages containing slash commands display as literal `/command args` text in the UI — this is intentional and preserves the original user intent.
- If a skill is deleted after it has been invoked in a thread, future re-expansion of that same turn (on retry or fork) will produce a skill-not-found error. This is acceptable; the correct user action is to re-send with a valid command.
- Agent-side skill discovery is via a `search_skills` LangGraph tool (optional keyword filter, returns enabled skill summaries). Skills are not enumerated in the system prompt — this avoids per-turn context cost for local models with limited context windows. The `search_skills` tool is called on demand when the model judges it useful.

---

### References

- AgentSkills specification: https://agentskills.io/specification
- AgentSkills client implementation guide: https://agentskills.io/client-implementation/adding-skills-support
- `lib/skills-manager/` — the `SkillsManager` library this feature builds on
- `api/src/agents/chat-agent.ts` — `createAgent` call site where the pre-LLM message transform will be added
- `api/src/agents/stream-handler.ts` — `streamChatToSse` (the Option A injection point, not used)
