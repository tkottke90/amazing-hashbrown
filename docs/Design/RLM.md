# Architecture — Recursive Language Models (RLM)

---

## 1. What Is an RLM and Why Use It

### The problem: local models have small working memory

Every language model has a hard limit on how much text it can hold in "working memory" at one time — this is called its **context window**. Think of it like a desk: the model can only work with what fits on the desk at once. Anything beyond that limit either gets cut off or degrades the quality of the model's reasoning.

A large cloud-hosted model (like GPT-4 or Claude) has an enormous desk — hundreds of thousands of words. A local 8B model running on consumer hardware has a much smaller one: roughly 16,000–24,000 characters (about 10–15 pages of text) before quality starts to degrade. This is fine for a quick question-and-answer. It becomes a problem when the model needs to reason over a long body of text — a user's accumulated wiki pages, a lengthy email thread, a detailed task history. That content — the **corpus** — can easily be 60,000–100,000 characters long. There are only two naive approaches:

1. **Truncate it.** Cut the corpus to fit the window. Anything beyond the limit is silently dropped. If the relevant answer was in the dropped portion, the model has no way to know.
2. **Stuff it.** Send everything and hope the model attends to the right parts. In practice, models under heavy context pressure attend to content near the beginning and end — material in the middle gets deprioritized, and answer quality degrades unpredictably.

Neither option is acceptable for a personal assistant that must be trustworthy.

### The RLM solution: give the model tools to read on demand

A **Recursive Language Model (RLM)** inverts the relationship. Instead of loading the entire corpus into the model's working memory, the corpus is kept _outside_ the model entirely — in a separate environment the model can query. The model is given a small set of named **tools** it can call to read specific pieces:

- Search for a keyword and get back matching lines
- Read a specific line range
- Find passages by meaning, not just keywords
- Summarize a section that is too long to read directly

The model calls a tool, gets back a small focused result, uses that to decide what to look at next, and repeats until it has enough to answer. It never receives the full corpus — it reads only what it currently needs.

This is why the pattern is called "recursive": the model loops, reading incrementally, before it can answer. The word also reflects its origin in research on using LLMs as recursive programs that can call sub-procedures (tool invocations) against external state.

**The key design constraint from that research:** rather than letting the model write arbitrary code to interact with the corpus (which requires strong code generation), a small fixed set of named operations is provided instead. This lowers the bar enough for local 8B-class models to participate reliably, and maps directly to the retrieval-over-memory use cases this system targets.

### When it activates

The RLM is a fallback, not the default path. Simple requests and short contexts go to a single direct model call with streaming enabled — the user gets a response starting in ~100ms. The RLM loop activates when the corpus exceeds the model's comfortable context budget, or when the query requires retrieval over a large document or memory store. For background tasks and automations, perceived latency is not a concern; the loop runs unobserved and its overhead is irrelevant to the experience.

**What POC validation confirmed** (POCs 001–003):

- A scaffolded RLM with the constrained toolkit outperforms truncated direct prompting on local 8B models — but _only_ in the regime where truncation actually bites. The routing decision is the thing that matters most.
- The mechanism is robust across the modern model class (every model trained for multi-turn tool use passes once thinking is disabled). The floor is training generation, not parameter count: a modern 4B beats a 2023-era 7B at this workload.
- Structural refusal (`not_found` tool) is the single highest-leverage honesty mechanism: restores 10/10 honesty on qwen3:8b without retrieval cost. Refusal must be a first-class tool, not a prompt instruction.
- Semantic search (`search` tool) closes the paraphrase gap on capable models. On less capable models, adoption is the barrier — keyword grep returns a plausible hit and the model stops there. For absence-heavy workloads, forced-search-first routing is the correct scaffold response.
- **Thinking/reasoning mode must be disabled everywhere the RLM loop runs.** Internal deliberation on top of the loop's iterative exploration is pure cost: thinking-on doubled median latency for marginally worse topic coverage. On remote serving, thinking tokens push queries over gateway timeouts and _look_ like infrastructure failure.

---

## 2. Architecture

### What Is a Corpus?

The **corpus** is the full body of text the RLM will search. In this system it is typically one or more wiki pages pulled from disk — the user's long-term memory — but it can be any block of text: a task history, a set of meeting notes, a long document. Concretely: the corpus is a single string passed to the `REPLEnvironment`. It is never sent to the model directly (see section 1 for why — the context window problem). The model only ever receives small, focused pieces of it, returned by the tools it calls.

The corpus is loaded once at the start of the loop and held in the `REPLEnvironment` for the duration. It does not change mid-loop.

---

### Components

Three components compose the RLM. Together they form a loop: the runner orchestrates, the adapter talks to the LLM, and the REPL environment holds the corpus and fulfills read requests.

```
┌─────────────────────────────────────────────┐
│                  RLMRunner                  │
│                                             │
│  Orchestrates the loop. Keeps a running     │
│  history of the conversation between the    │
│  model and the tools. Decides when the loop │
│  is done and what to return.                │
└──────────┬──────────────────────────────────┘
           │ sends: message history + available tools
           │ receives: tool call or final answer
           ▼
┌─────────────────────────────────────────────┐
│               ModelAdapter                  │
│         (OllamaAdapter implements this)     │
│                                             │
│  The bridge to the LLM. Translates the      │
│  runner's message history into a model      │
│  request, sends it, and returns the         │
│  model's response — either a structured     │
│  tool call or a plain text answer.          │
│                                             │
│  Strips reasoning tokens (think-blocks)     │
│  from output. Retries once on HTTP 5xx.     │
└──────────┬──────────────────────────────────┘
           │ tool call (e.g. grep("Marcus"))
           │                   ▲
           │                   │ result (e.g. "line 412: Marcus said...")
           ▼                   │
┌─────────────────────────────────────────────┐
│              REPLEnvironment                │
│                                             │
│  The corpus lives here — not in the model's │
│  context window. The model never receives   │
│  the full text; it only gets back the small │
│  result of each tool call it makes.         │
│                                             │
│  Executes the nine REPL tools against the   │
│  stored corpus text. For summarize/query,   │
│  spawns an isolated sub-call to the model   │
│  (a fresh ModelAdapter call with only the   │
│  target chunk — no loop history).           │
│                                             │
│  Builds the search index internally when an │
│  embedding adapter is wired in. Manages the │
│  provenance store when included in corpus.  │
└─────────────────────────────────────────────┘
```

---

### End-to-End Flow

This diagram shows the full path from a user message to an answer, including the decision of whether to enter the RLM loop at all and how the model and corpus interact inside it.

```
┌──────────────────────────────────────────────────────────────────────┐
│  USER MESSAGE                                                         │
│  "What did Marcus recommend about the Q4 timeline?"                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTER  (deterministic code, < 5ms, no inference)                    │
│                                                                       │
│  Measures the assembled corpus size.                                  │
│                                                                       │
│  Fits in context window?  ──Yes──►  DIRECT CALL                      │
│  (roughly ≤ 24,000 chars)            Single model call, streaming.   │
│                                      First word back in ~100ms.      │
│                                                                       │
│  Too large?  ──No──►  enter RLM loop below                           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
                   ┌────────────────────────┐
                   │    CORPUS ASSEMBLY     │
                   │                        │
                   │  Load relevant wiki    │
                   │  pages or documents    │
                   │  from disk into a      │
                   │  single text string.   │
                   │                        │
                   │  Example:              │
                   │  project-wiki.md       │
                   │  → 85,000 chars        │
                   │    (~2,100 lines)      │
                   └───────────┬────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  RLM RUNNER                                                           │
│                                                                       │
│  The corpus is loaded into the REPL Environment.                     │
│  The model is told: "You have a document. You cannot see it          │
│  directly. Use these tools to find the answer."                      │
│                                                                       │
│  ┌───────────────────────────┐     ┌──────────────────────────────┐  │
│  │      MODEL ADAPTER        │     │      REPL ENVIRONMENT        │  │
│  │                           │     │                              │  │
│  │  Each iteration, sends    │     │  The corpus lives here.      │  │
│  │  the LLM:                 │     │  The LLM never receives      │  │
│  │  • The user's question    │     │  the full text. It only      │  │
│  │  • Corpus metadata        │     │  gets back the result of     │  │
│  │    (size + line count)    │     │  each tool call it makes.    │  │
│  │  • The tools it can use   │     │                              │  │
│  │  • All prior tool calls   │     │  On a tool call:             │  │
│  │    and their results      │     │  peek  → first N chars       │  │
│  │                           │     │  grep  → keyword search      │  │
│  │  The LLM responds with:   │     │  slice → a line range        │  │
│  │                           │  ┌──│  search→ meaning-based find  │  │
│  │  (a) A tool call ─────────┼──┘  │  summarize → distill section │  │
│  │      needs more to answer │◄────│  not_found → honest refusal  │  │
│  │                           │     │  final_answer → done         │  │
│  │  (b) final_answer         │     │                              │  │
│  │      has the answer       │     │  Returns a small focused     │  │
│  │                           │     │  result — never the full     │  │
│  │  (c) not_found            │     │  corpus.                     │  │
│  │      answer not in corpus │     │                              │  │
│  └───────────────────────────┘     └──────────────────────────────┘  │
│                                                                       │
│  After each tool result, the runner appends it to the conversation   │
│  history and calls the model again. This repeats until the model     │
│  calls final_answer, calls not_found, or the iteration limit is hit. │
│                                                                       │
│  Status signals are emitted to the caller throughout the loop,       │
│  using plain language: "Searching your memory...",                   │
│  "Reading relevant section..." — never exposing internal tool names. │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
             ┌──────────────────────────────────┐
             │         ANSWER RETURNED          │
             │                                  │
             │  found: true  → answer text      │
             │  found: false → "not in corpus"  │
             └──────────────────────────────────┘
```

---

### Loop Flow

Step-by-step mechanics of what the runner does on each iteration:

```
1. Load corpus into REPLEnvironment.
   The corpus text is stored here — never sent to the model directly.

   The corpus arrives pre-assembled. The RLM module has no file-system
   awareness and no logic for deciding what to include — that is the
   caller's responsibility (see "Corpus Assembly" in section 8). The
   module assumes the caller has already selected a relevant, bounded
   body of text and concatenated it into a single string.

2. Send initial message to the model:
   • User query
   • System prompt describing the toolkit and its constraints
   • Corpus metadata: character count, line count, source label
   (The model now knows the corpus exists and how large it is,
    but has not seen any of its content yet.)

3. Loop (up to max_iterations):

   a. Model responds with a tool call OR plain text.

   b. If final_answer called  → return the answer. Done.
      If not_found called     → return found:false. Done.
      If plain text, no tools → treat as the final answer. Done.

   c. Check for a repeated tool call (same tool + same args as the
      previous call). If detected: inject a warning message and
      subtract 2 from the remaining iteration budget, steering the
      model toward a different approach.

   d. Execute the tool call against the REPLEnvironment.
      The result is always a small, bounded string — never the
      full corpus.

   e. Emit a status signal to the caller (e.g. "Searching your
      memory..."). The signal uses plain conversational language,
      not the internal tool name.

   f. Append the tool result to the message history.
      The model will see the full conversation — question,
      every tool call, every result — on the next iteration.

4. If max_iterations is reached without a final answer:
   Inject a message: "Synthesize your best answer from what you
   have gathered so far." Call the model once more with all tools
   suppressed — it can only respond in plain text. If the model
   emits tool-call syntax anyway (a known failure mode under
   context pressure), retry once with an explicit plain-text-only
   instruction before returning what is available.

5. Return RLMResult: answer text, found flag, termination reason,
   full tool call trace, and timing.
```

---

### Sub-call Isolation

`summarize` and `query` spawn a fresh `ModelAdapter.complete()` call with only the target chunk and the sub-call instruction. The sub-call model sees no loop history, no corpus metadata — just the text slice and the task. Its output returns as the tool result to the root model. This isolation is what makes sub-calls safe to use as scoped readers: their verdict is scoped to their range ("not found in lines 200–400"), nothing more. Treating a sub-call NOT FOUND as corpus-wide absence is a root-level error — the sub-call is a leaf, not an oracle.

---

### Provenance

**Provenance** is the record of where each fact in the corpus came from. When a fact is written into memory — say, "Marcus is the lead on the DataBridge project, starting Q3 2025" — the system records alongside it: which source document introduced this fact, what type it was (an email, a meeting note, a calendar event), and when it was written. That record is stored in the **provenance store**, a separate file that travels with the corpus.

The provenance store exists because memory degrades over time in ways that are invisible if you only look at the current content. A fact that was accurate when it was written may be stale a year later. Without provenance, the RLM can retrieve the fact and report it confidently — but neither the model nor the user has any signal that the source is 18 months old and probably needs re-verification.

With provenance, the RLM can do two things:

1. **Answer sourcing questions.** When a user asks "where did you get that?" the model can call `get_provenance` and return the original source — the specific email, document, or meeting note the fact came from, along with its age. This makes retrieved answers auditable rather than opaque.

2. **Signal staleness.** The provenance store supports a staleness scan: given an entity, return all facts whose source documents are older than a threshold. A fact sourced from a 2-year-old HR email is a candidate for re-verification; a fact sourced from last week's meeting is not. The model can use this signal to calibrate how much weight to put on what it retrieves.

**What POC-019 confirmed:**

- Provenance recording is negligible overhead: 0.6–1.0ms per write, regardless of corpus size or source type.
- Attribution is deterministic code, not model-generated — the source document ID is wired in at write time, before the model processes the content. This means attribution is correct even when the model routes a fact to the wrong wiki section: the provenance entry reflects the actual source, not the model's routing decision.
- The enriched stale report is categorically more useful than a count. Instead of `stale=2`, the output tells you: which facts are stale, which source documents they came from, and how old those sources are — enough to know exactly what to go verify and why.
- Nine source types were tested (email, meeting notes, blog post, YouTube transcript, server log, cron log, project doc, website, Reddit post) with identical provenance quality across all of them. Source type is metadata for the record; it is invisible to the model's write path.

**Key design decision:** provenance is anchored to the **canonical claim text** extracted at write time, not to the final page text after the model rewrites it. The page text is a rendered artifact — its wording may change across rewrites. The canonical claim is stable. This means a lookup of `"Marcus Delacroix is the lead on DataBridge"` finds the provenance entry even after the wiki page has been rewritten five times and the sentence now reads differently.

**Current limitation:** the store uses substring match for lookup. When the RLM queries provenance, it will produce a natural-language paraphrase of the fact — not the exact canonical claim text. Substring match fails on paraphrases. Production implementation requires fuzzy or vector-based claim lookup to make `get_provenance` reliably callable from within the loop (see the tool entry in section 3).

---

## 3. REPL Toolkit

**REPL** stands for **Read–Eval–Print Loop** — a programming concept for an interactive environment where you submit a command, get a result, and decide what to do next based on that result. The name is borrowed here because the RLM loop follows the same pattern: the model submits a tool call (read), the environment executes it (eval), the result is returned to the model (print), and the model decides its next move (loop). The key difference from a traditional REPL is that the "user" typing commands is the model itself, not a human.

Nine named operations make up the toolkit. The model never writes raw code — it calls these by name with typed arguments.

### `peek(chars: number) → string`

Returns the first N characters of the corpus. Always the first call in a well-formed loop — orients the model to the document's structure, format, and vocabulary before searching. On structured wiki content with headings, a peek of 2000–3000 chars is usually enough to map the document.

**When to use:** start of every loop session. If the document structure is unknown, peek first.
**POC finding:** all well-performing models called peek or grep as their first action. Models that skipped orientation and went straight to a narrow grep frequently missed the right region on the first pass.

---

### `grep(pattern: string, maxResults?: number) → string`

Regex search over the full corpus. Returns matching lines with their line numbers. Default max 50 results; configurable per call.

**When to use:** when the question contains terms likely to appear verbatim in the document (proper nouns, technical identifiers, section headings). The workhorse for well-structured content.
**POC finding:** grep+slice was the dominant strategy across all well-performing models (POC-001: slice ×13, grep ×10 across all queries). On structured markdown, grep-for-section-heading → slice-the-hit-region solves most class-A questions. On unstructured prose, grep is weak — use `search` instead.
**Error message design matters:** the error text when a grep request exceeds maxResults is a prompt. "Try narrowing with a more specific pattern, or use `summarize` for large ranges" steers the model toward the right next action; a bare "too many results" does not.

---

### `slice(startLine: number, endLine: number) → string`

Reads a specific line range from the corpus. Hard cap at 200 lines per call; requests beyond the cap are rejected with an error suggesting `summarize` for large ranges.

**When to use:** after grep or search identify a promising region — read the actual text before answering from it. Always verify before committing.
**POC finding:** greedy slicing is the model's instinct — early iterations frequently attempted ranges like `slice(41, 1034)`, attempting to reload the whole document through the keyhole. The 200-line cap enforces discipline; the error text must steer toward `summarize` for the model to pivot correctly rather than burning iterations on retry-with-smaller-range.

---

### `summarize(startLine: number, endLine: number, focus?: string) → string`

Spawns an isolated sub-call: a fresh model call over only the specified chunk, returning a summary. The optional `focus` parameter narrows the summary to a specific question or topic. The sub-call model sees no loop history.

**When to use:** when a relevant region exceeds the slice cap (>200 lines), or when the model needs a condensed view of a long section before deciding whether to read it in detail. The escape hatch for over-cap ranges that the model otherwise has no way to process.
**POC finding:** barely used on structured content; earned its place on unstructured prose and log corpora. On the mixed-content eval, sub-call usage was highest on absence-class questions — models search hardest before refusing.
**Sub-call as leaf:** the summary verdict is scoped to the specified range. A summary that says "this section discusses X but does not mention Y" doesn't mean Y is absent from the corpus — only from lines start–end.

---

### `query(question: string, startLine: number, endLine: number) → string`

Spawns an isolated sub-call: a fresh model call over the specified chunk, tasked with answering a specific question. More targeted than `summarize` — returns an answer rather than a summary, with "NOT FOUND IN THIS RANGE" if the chunk doesn't contain the answer.

**When to use:** when the model needs a direct answer from a specific region rather than a summary. Particularly useful when the candidate region is large and the question is narrow.
**POC finding:** `query` was never called in the POC-001 eval runs (0 calls across all queries). `grep` + `slice` was sufficient for structured content; `summarize` handled the cases where regions were too large. On unstructured prose, `search` (semantic) is a better first tool than `query` for paraphrase-gap cases. `query` remains in the toolkit for cases where a candidate region is known and targeted Q&A is needed.

---

### `search(query: string, topK?: number) → string`

Semantic vector search over the whole corpus. Finds passages by meaning, not keywords — the complement to `grep`. Returns candidate regions with line numbers and similarity scores. Default top-5 results. Results are candidates, not answers; always read a region (slice) before relying on it.

Requires a pre-built `CorpusIndex` (vector embeddings of chunked corpus text) to be passed to the `REPLEnvironment`. If no index is provided, the tool is not advertised to the model.

**When to use:** when the document might phrase the answer differently than the question — idiomatic language, paraphrase, or domain-specific vocabulary. After grep returns nothing useful. Query with plain content words describing what the passage would say, not the question's wording.
**POC finding (POC-003):** closes the paraphrase gap on capable models — focal cases that were impossible with keyword retrieval now score reliably. On GLM-4.7-Flash: class-B average moved +1.6 (threshold: +1.0); the quoted-reversal trap that defeated every prior configuration was solved. On qwen3:8b: adoption failed specifically on the hardest cases because grep returned a plausible-looking hit first (satisficing-confidence barrier). Fix: force search-first routing for high-risk cases; do not rely on the model choosing to search after a plausible grep hit.
**Repeated queries blocked:** identical consecutive search queries return a steering message rather than identical results, same as the loop detection for grep.

---

### `get_provenance(fact: string) → string`

Queries the provenance store for a specific fact. Returns the source document, type, timestamp, and age of the canonical claim. See the Provenance section in Architecture (section 2) for full context on what the provenance store is and why it exists.

Requires a `ProvenanceStore` instance to be passed to the `REPLEnvironment`. If no store is provided, the tool is not advertised to the model.

**When to use:** when the user asks where a fact came from, or when the model needs to assess whether a retrieved fact is recent enough to trust.
**Implementation note:** the current store uses substring match on canonical claim text. Because the model queries with natural-language paraphrases rather than the exact stored claim, matches will often fail. Production use requires fuzzy or vector-based lookup — this is the primary gap before `get_provenance` is fully reliable inside the loop.

---

### `not_found(searched: string) → never`

Structural refusal tool. When the model has exhausted its search and cannot find the answer in the corpus, it calls `not_found` with a description of what it searched. The loop treats this as a terminal call — equivalent to `final_answer`, but with an explicit not-found result. Signals a safe failure rather than a synthesized fabrication.

**Why structural, not textual:** prompt-only honesty instructions are unreliable under retrieval pressure regardless of model size. Making refusal a first-class tool legitimizes it in the model's decision space — the presence of the tool in the schema is what matters, not whether the model calls it on every absent case. POC-002 finding: qwen3:8b went from 6/10 honest to 10/10 honest purely by adding the `not_found` tool, without any change to prompt instructions or retrieval scaffolding. GLM-4.7-Flash holds both the honesty and persistence dials simultaneously — the tool is a mid-tier prosthetic, exactly where it is most needed (typical local hardware runs mid-tier models).
**POC finding:** the tool only needed to be _called_ on 4 of 10 absent cases for honesty to go 10/10 — its presence legitimizes refusal on the other 6 cases where the model refuses via the `final_answer` path instead. Structure substitutes for capability on the honesty axis.

---

### `final_answer(content: string) → never`

Clean termination signal. The model calls this tool with its final synthesized answer. The loop exits and returns the content as the result. The preferred termination path — structured, explicit, parser-safe.

**Why structural:** same principle as `not_found`. A plain-text response with no tool call is the secondary termination path (treating the response as the answer), but this requires the adapter to detect "no tool call" as a signal rather than a loop error. `final_answer` as a tool gives the model a clean, unambiguous exit mechanism. POC-001 finding: GLM-4.7-Flash terminated via `final_answer` 7/8 times (the cleanest tool discipline of any tested model); qwen3:8b terminated via `final_answer` only 4/8 times — the primary "no tool call" mechanism carried the other half.

---

## 4. Termination & Loop Control

Three exit paths, in priority order:

**1. `final_answer` tool call.** The model explicitly signals it is done. Clean path. The `content` argument becomes the answer.

**2. Plain text response (no tool call).** When the model returns a message with no tool calls, the loop treats the text content as the final answer. Secondary path — less reliable than `final_answer` because the adapter must detect absence of tool calls, but essential as a fallback for models with inconsistent tool discipline.

**3. Max iterations failsafe.** Default 10 iterations. When the limit is hit, a synthesis message is injected: _"You have reached the maximum number of steps. Synthesize your final answer from what you have gathered so far."_ The model is called once more with the full tool list suppressed (tools set to `[]`). If the model responds with another tool call format despite tools being suppressed (the "escaped `<tool_call>`" failure mode observed on Qwen3), the synthesis is retried once with an explicit "plain text only" instruction before returning whatever is available.

**Infinite loop detection.** Track the last 3 tool calls. If the same tool + arguments appears twice consecutively, inject a warning message and decrement the remaining iteration budget by 2. Also blocks identical consecutive `search` queries at the handler level — returns a steering message instead of duplicate results.

**Synthesis failure handling.** On forced synthesis (max_iterations path), if the model produces `<tool_call>` XML or structured JSON instead of prose text, the adapter attempts one retry with a plain-text-only constraint. If the retry also fails, the result is marked as a synthesis failure and a `[synthesis failed]` marker is emitted rather than returning raw JSON as the answer.

**Thinking mode.** Disable `think: false` on all model calls in the loop. Thinking tokens are pre-answer overhead that adds latency (doubles median on qwen3:8b) with no quality gain — the loop's iterative structure already externalizes the exploration that thinking tokens would duplicate. On remote serving, thinking tokens can push queries over gateway timeouts and appear as infrastructure failure.

---

## 5. TypeScript Project Structure

The RLM module is a standalone TypeScript workspace package with no application dependencies. It is consumed by the application layer as a library.

```
src/
  types.ts          ← all shared types and the DEFAULT_CONFIG constant
  adapter.ts        ← ModelAdapter interface + OllamaAdapter implementation
  repl.ts           ← REPLEnvironment class (corpus storage + tool execution)
  runner.ts         ← RLMRunner class (the main loop)
  prompts.ts        ← system prompt templates (root LM + sub-call)
  search.ts         ← RlmEmbeddingAdapter interface, NoOpEmbeddingAdapter, OllamaEmbeddingAdapter, internal index build + search tool
  provenance.ts     ← ProvenanceStore class + get_provenance tool handler
  index.ts          ← public module exports (re-exports from above)

test/
  unit/
    repl.test.ts          ← REPL tool behavior (peek, grep, slice caps, truncation)
    termination.test.ts   ← loop exit paths, max_iterations, loop detection
    parser.test.ts        ← tool call parsing: native, <tool_call> XML, bare JSON
    search.test.ts        ← chunking, embedding, index build + query
    provenance.test.ts    ← store write, lookup, supersession
  integration/
    runner.mock.test.ts   ← full loop with scripted MockAdapter (no inference)
    runner.real.test.ts   ← real inference (tagged @slow, opt-in)
```

**Adapter escape formats.** Three tool-call formats have been observed from real models and must all be parsed:

- Native Ollama/OpenAI structured `tool_calls` array (preferred path; GLM-4.7-Flash, qwen3:8b)
- `<tool_call>{...}</tool_call>` XML escape (Qwen3 under context pressure)
- Bare JSON array `[{"name":"grep",...}]` (Mistral 7B)

The `adapter.ts` text-fallback parser handles all three. Unknown tool names (e.g. the `"peep"` invented name observed on qwen3.5:4b) route to the unknown-tool error handler — never silently ignored.

---

## 6. Key Types

These types are the public contract between the RLM module and its callers. They are defined in `src/types.ts` and re-exported from `src/index.ts`.

```typescript
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[]; // present on assistant messages
  toolName?: string; // present on tool messages: which call this answers
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelResponse {
  content: string; // plain text (may be empty when toolCalls is non-empty)
  toolCalls: ToolCall[]; // empty array when model responded in text
  durationMs: number;
}

export interface RLMConfig {
  model: string; // e.g. "glm-4.7-flash", "qwen3:8b"
  subModel?: string; // model for sub-calls; defaults to model
  ollamaBaseUrl: string; // e.g. "http://localhost:11434"
  maxIterations: number; // default 10
  maxResultTokens: number; // default 2000 (estimated at 4 chars/token)
  maxSliceLines: number; // default 200
  think?: boolean; // default false — must be off for loop reliability
  promptAddendum?: string; // appended to root system prompt (e.g. honesty instructions)
  extraTools?: Tool[]; // additional tools beyond the core toolkit
}

export const DEFAULT_CONFIG: RLMConfig = {
  model: 'qwen3:8b',
  ollamaBaseUrl: 'http://localhost:11434',
  maxIterations: 10,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
};

export type TerminationReason =
  | 'final_tool' // model called final_answer
  | 'not_found_tool' // model called not_found
  | 'no_tool_call' // model returned plain text with no tool call
  | 'max_iterations'; // loop hit the iteration ceiling

export interface ToolCallRecord {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string; // first 200 chars of result (for debugging)
  durationMs: number;
}

export interface RLMResult {
  answer: string;
  found: boolean; // false when terminationReason is "not_found_tool"
  iterations: number;
  toolCallTrace: ToolCallRecord[];
  terminationReason: TerminationReason;
  loopDetectionFired: boolean;
  totalDurationMs: number;
}

// Status signal emitted during the loop — callers use this for progress UI
export interface StatusSignal {
  phase: 'searching' | 'reading' | 'summarizing' | 'querying' | 'answering' | 'not_found';
  message: string; // e.g. "Searching your memory...", "Reading relevant section..."
  iteration: number;
  tool?: string; // internal tool name — for logging, not for display to users
}

export type StatusCallback = (signal: StatusSignal) => void;

// Embedding adapter — implemented by OllamaEmbeddingAdapter; NoOpEmbeddingAdapter is the default
export interface RlmEmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

// Default when no embedding adapter is provided — disables the search tool
export class NoOpEmbeddingAdapter implements RlmEmbeddingAdapter {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}

// Corpus passed to the runner
export interface RLMCorpus {
  text: string;
  source?: string; // label for status messages and provenance
  provenance?: ProvenanceStore; // if provided, get_provenance tool is activated
  // No searchIndex here — the runner builds the index internally when an
  // embedding adapter is provided at construction time.
}
```

---

## 7. Module API Interface

The module exports one primary class (`RLMRunner`) and the adapters, stores, and types needed to configure it. The caller is responsible for constructing adapters and indexes; the runner is responsible for the loop.

### `ModelAdapter` interface

```typescript
export interface ModelAdapter {
  complete(messages: Message[], tools: Tool[], config: RLMConfig): Promise<ModelResponse>;
}
```

All inference goes through this interface. `OllamaAdapter` is the bundled implementation; the seam exists so callers can swap to a different inference provider by implementing the interface. Adding a provider requires only implementing `ModelAdapter` — no changes to the runner or REPL.

### `OllamaAdapter`

```typescript
export class OllamaAdapter implements ModelAdapter {
  constructor(opts: {
    baseUrl: string;
    model: string;
    think?: boolean; // forwarded to Ollama's chat_template_kwargs
    retryOn5xx?: boolean; // default true — one retry on HTTP 5xx
  });
  complete(messages: Message[], tools: Tool[], config: RLMConfig): Promise<ModelResponse>;
}
```

Uses Ollama's native `/api/chat` endpoint (not the OpenAI-compatible `/v1/chat/completions`). This is required for `think: false` to work correctly on Qwen3-family models — the Ollama native endpoint accepts `chat_template_kwargs` which is the control knob for reasoning mode. The adapter strips `<think>...</think>` blocks from model output before returning.

### `RLMRunner`

```typescript
export class RLMRunner {
  constructor(
    adapter: ModelAdapter,
    embeddingAdapter?: RlmEmbeddingAdapter, // omit or pass NoOpEmbeddingAdapter to disable search
    config?: Partial<RLMConfig>,
  );

  run(query: string, corpus: RLMCorpus, onStatus?: StatusCallback): Promise<RLMResult>;
}
```

The `run()` call is the primary entry point. It creates a `REPLEnvironment` from `corpus`, builds the search index internally if an `embeddingAdapter` was provided at construction time, assembles the tool list (core toolkit + optional search/provenance tools), and runs the loop. When no embedding adapter is provided (or `NoOpEmbeddingAdapter` is used), the `search` tool is omitted from the toolkit.

### `REPLEnvironment`

```typescript
export class REPLEnvironment {
  constructor(
    corpus: RLMCorpus,
    config: RLMConfig,
    subAdapter: ModelAdapter,
    embeddingAdapter?: RlmEmbeddingAdapter,
  );

  execute(call: ToolCall): Promise<string>;

  // Read-only accessors for the runner
  readonly lineCount: number;
  readonly charCount: number;
  readonly source: string | undefined;
}
```

Not typically constructed directly by application code — the runner creates it internally. Exported for testing and for callers building custom loop scaffolding.

### Embedding adapters

Semantic search is optional. Pass an `RlmEmbeddingAdapter` to the `RLMRunner` constructor to enable it; omit the argument (or pass `NoOpEmbeddingAdapter`) to disable it. The runner builds and manages the search index internally — the caller never touches a `CorpusIndex` directly.

```typescript
// The interface — implement this to bring your own embedding provider
export interface RlmEmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

// Default no-op — search tool is omitted when this is active
export class NoOpEmbeddingAdapter implements RlmEmbeddingAdapter {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}

// Bundled Ollama implementation (qwen3-embed-0.6b is the validated model)
export class OllamaEmbeddingAdapter implements RlmEmbeddingAdapter {
  constructor(opts: { baseUrl: string; model: string });
  embed(texts: string[]): Promise<number[][]>;
}
```

### `ProvenanceStore`

```typescript
export class ProvenanceStore {
  // Write a provenance entry when a fact is written to the wiki
  async record(entry: ProvenanceEntry): Promise<void>;

  // Query by fact text (substring match; fuzzy/vector lookup needed for production paraphrases)
  async lookup(factText: string): Promise<ProvenanceEntry[]>;

  // Staleness scan: entries whose source is older than maxAgeDays
  async stale(entityId: string, maxAgeDays: number): Promise<ProvenanceEntry[]>;
}

export interface ProvenanceEntry {
  entityId: string; // e.g. wiki page identifier
  claimText: string; // canonical claim text, resolved at write time
  sourceDocId: string; // source document identifier
  sourceType: string; // "email" | "meeting-notes" | "calendar" | ...
  writtenAt: string; // ISO date when the fact was written to the wiki
  supersededBy?: string; // claimText of the superseding entry, if stale
}
```

### Full public export surface (`src/index.ts`)

```typescript
// Classes
export { RLMRunner } from './runner.ts';
export { REPLEnvironment } from './repl.ts';
export { OllamaAdapter } from './adapter.ts';
export { NoOpEmbeddingAdapter, OllamaEmbeddingAdapter } from './search.ts';
export { ProvenanceStore } from './provenance.ts';

// Types
export type {
  Role,
  Message,
  Tool,
  ToolCall,
  ModelResponse,
  RLMConfig,
  RLMResult,
  RLMCorpus,
  TerminationReason,
  ToolCallRecord,
  StatusSignal,
  StatusCallback,
  ModelAdapter,
  RlmEmbeddingAdapter,
  ProvenanceEntry,
} from './types.ts';

// Constants
export { DEFAULT_CONFIG } from './types.ts';
```

---

## 8. Module Integration Example

### Corpus Assembly (caller's responsibility)

The RLM module receives a corpus string. It does not know where that string came from, does not access the filesystem, and has no logic for selecting what to include. Deciding what goes into the corpus — and keeping it to a manageable size — is the caller's job, done before `runner.run()` is called.

**Why pre-selection matters.** The RLM loop is not a substitute for filtering. It is a tool for answering a specific question over a large-but-bounded body of text. Passing an entire codebase or a full email archive as the corpus is not the right use; the loop will exhaust its iteration budget searching for signal in noise. The caller should narrow the corpus to the plausible search space first.

**Common assembly strategies:**

| Use case                 | Strategy                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wiki pages               | Keyword-score all sections against the query; concatenate sections above threshold. (This is how the system in ARCHITECTURE.md works — keyword scoring runs before the router, so the corpus is already pre-filtered when it arrives.) |
| Codebase                 | Grep for the symbol, filename, or concept in the query; load the matching files and their immediate imports. Do not load the full repository.                                                                                          |
| Email / document archive | Filter by date range and keyword match; concatenate the filtered set.                                                                                                                                                                  |
| Task history             | Load tasks whose title or tags intersect the query's subject.                                                                                                                                                                          |

**Size target.** The corpus should be large enough that truncation would lose the answer, but not so large that it is structurally unnarrowed. A practical ceiling is whatever fits on a single long wiki page or a handful of related source files — typically 40,000–120,000 characters. If the candidate set exceeds that, apply a second-pass filter before handing off.

**The corpus is a string, not a file list.** The caller concatenates the selected content into a single string, optionally with section headers or file-path comments to give the model orientation within the text. The `source` field on `RLMCorpus` is a label for status messages and provenance — it is not a file path the module reads from.

---

The RLM module is invoked by the application's router when a query requires corpus retrieval. The caller builds the corpus object, optionally attaches a provenance store, passes a status callback for streaming progress to the UI, and receives a typed result. Semantic search is enabled by passing an `OllamaEmbeddingAdapter` at construction time — the runner builds and manages the search index internally.

```typescript
import {
  RLMRunner,
  OllamaAdapter,
  OllamaEmbeddingAdapter,
  ProvenanceStore,
  DEFAULT_CONFIG,
  type RLMCorpus,
  type StatusSignal,
} from '@tkottke90/rlm-client';

// --- Adapter setup (done once at app startup) ---

const adapter = new OllamaAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:8b',
  think: false, // required for loop reliability
  retryOn5xx: true,
});

// Passing OllamaEmbeddingAdapter enables the search tool.
// Omit this argument (or pass NoOpEmbeddingAdapter) to disable semantic search.
const embeddingAdapter = new OllamaEmbeddingAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3-embed-0.6b',
});

const runner = new RLMRunner(adapter, embeddingAdapter, {
  ...DEFAULT_CONFIG,
  maxIterations: 10,
  maxResultTokens: 2000,
});

// --- Provenance store ---

const provenance = new ProvenanceStore({ path: 'wikis/user.provenance.jsonl' });

// --- Running a query ---

const wikiText = await fs.readFile('wikis/user.md', 'utf-8');

const corpus: RLMCorpus = {
  text: wikiText,
  source: 'user-wiki',
  provenance, // activates the get_provenance tool
  // No searchIndex here — the runner builds the index on first run.
};

// Status callback: translate internal signals to user-facing messages for the UI.
// tool names are internal; phase and message are what the user sees.
function onStatus(signal: StatusSignal): void {
  emitToClient({ type: 'rlm_status', message: signal.message });
}

const result = await runner.run(userQuery, corpus, onStatus);

if (!result.found) {
  // Model called not_found — safe failure, no fabrication
  return { answer: null, source: 'not_found' };
}

return {
  answer: result.answer,
  source: 'rlm',
  iterations: result.iterations,
  terminatedCleanly: result.terminationReason !== 'max_iterations',
};
```

### Routing decision (application layer)

The router decides whether to enter the RLM loop. The decision is deterministic code, not inference:

```typescript
const CONTEXT_BUDGET_CHARS = 24_000;

function route(query: string, corpus: string): 'direct' | 'rlm' {
  if (corpus.length <= CONTEXT_BUDGET_CHARS) return 'direct';
  return 'rlm';
}
```

The router is owned by the application, not the module. The module assumes the caller has already decided that the RLM path is warranted; it does not perform routing internally.

### Status signal vocabulary

Status messages describe the activity from the user's perspective in plain language, not the internal tool name:

| Tool called      | Phase         | Example message                              |
| ---------------- | ------------- | -------------------------------------------- |
| `peek`           | `searching`   | "Checking your memory..."                    |
| `grep`           | `searching`   | "Searching your memory..."                   |
| `search`         | `searching`   | "Searching for relevant context..."          |
| `slice`          | `reading`     | "Reading relevant section..."                |
| `summarize`      | `summarizing` | "Reviewing a longer section..."              |
| `query`          | `querying`    | "Checking a specific part of your memory..." |
| `get_provenance` | `reading`     | "Looking up the source of that..."           |
| `final_answer`   | `answering`   | — (no signal; answer follows immediately)    |
| `not_found`      | `not_found`   | — (no signal; not-found result returned)     |

---

## Change Log

### 2026-07-06 — Initial document

Compiled from POCs 001–003 and POC-019. Supersedes the design notes in `POCs/001 - RLM/RLM.md` (which reflects only the POC-001 design and was never updated with later tool additions). Key additions over the original:

- `not_found` structural refusal tool (POC-002)
- `search` semantic tool (POC-003)
- `get_provenance` tool (POC-019; provenance store design validated; RLM integration pending fuzzy lookup)
- `TerminationReason` extended with `"not_found_tool"`
- `found: boolean` added to `RLMResult`
- `loopDetectionFired` and `totalDurationMs` in `RLMResult` (from actual POC-001 implementation)
- `think`, `promptAddendum`, `extraTools` in `RLMConfig`
- `StatusSignal` / `StatusCallback` for progress emission (specified in CONCEPT.md; formalized here)
- `RLMCorpus` type for structured corpus input
- Three adapter escape formats documented (native, XML, bare JSON)
- Module API Interface and integration example sections (new)
