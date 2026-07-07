# `@tkottke90/rlm`

Retrieval-loop engine that lets a small local model answer questions from a corpus too large to fit in its context window, by giving it a set of named read tools and orchestrating the loop until an answer is found.

## The problem this solves

Local 8B-class language models (Qwen3, Mistral, Llama 3) have usable context windows of roughly 16–24 thousand characters. A user's accumulated notes, wiki, or knowledge base is typically 60–120 thousand characters. You can't fit the whole thing in a single call.

The naive options are both bad: truncate the corpus (miss relevant content) or use a larger remote model (latency, cost, privacy). The **Retrieval Loop Model** pattern is a different approach: keep the corpus entirely outside the model, and give the model a small set of named read tools — peek at the start, search by keyword, read a line range, summarize a section. The model loops through these tools, retrieving only the fragments it needs, until it has enough to answer. It never sees the full corpus.

## What this library does

- **Orchestrates the retrieval loop** — runs a conversation loop where the model calls document tools until it calls `final_answer` (found) or `not_found` (genuinely absent).
- **Provides nine REPL tools** to the model: `peek`, `grep`, `slice`, `summarize`, `query`, and optionally `search` (semantic), `get_provenance`, `not_found`, `final_answer`.
- **Handles all termination paths**: explicit answer, explicit not-found, plain-text response, and a `max_iterations` ceiling with automatic synthesis.
- **Detects infinite loops** — tracks the last three tool calls and injects a corrective message when the model repeats the same call consecutively.
- **Emits a structured event stream** — every model call, tool dispatch, and result is an observable event, with matched pairs linked by `correlationId` for UI rendering.
- **Produces a complete audit trace** at run completion, renderable as human-readable text via `formatTrace`.

## What this library does NOT do

- **No LLM inference.** You provide a `ModelAdapter` — the library calls it, but has no knowledge of any specific API.
- **No corpus assembly.** You pass a plain string. What text goes in it, and how it's concatenated, is your responsibility.
- **No routing logic.** Deciding when to use the retrieval loop versus a direct streaming call is the application's job.
- **No filesystem access.** The corpus is passed in as `{ text: string }`. Reading files is your responsibility.
- **No UI.** The library emits structured events and a `StatusSignal`; rendering them is your responsibility.

---

## Quick start

```ts
import { RLMRunner } from '@tkottke90/rlm';
import { OllamaAdapter } from '@tkottke90/rlm/adapters';
import { readFileSync } from 'node:fs';

const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434', model: 'qwen3:8b' });
const runner = new RLMRunner(adapter, undefined, { think: false });

const corpus = {
  text: readFileSync('./my-notes.md', 'utf8'),
  source: 'my-notes',
};

const result = await runner.run('Who leads the DataBridge project?', corpus);

if (result.found) {
  console.log(result.answer); // "Marcus Delacroix"
} else {
  console.log('Not found after', result.iterations, 'iterations');
}
```

---

## Documentation

| File                                                 | Contents                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [docs/getting-started.md](./docs/getting-started.md) | Prerequisites, install, first query, reading the result, adding semantic search, UI status updates |
| [docs/api-reference.md](./docs/api-reference.md)     | All public classes, interfaces, functions, and the nine REPL tools                                 |
| [docs/observability.md](./docs/observability.md)     | Event stream, `RLMLogger`, `formatTrace`, metrics, source attribution                              |
| [docs/custom-adapters.md](./docs/custom-adapters.md) | Implementing `ModelAdapter` and `RlmEmbeddingAdapter` for any LLM backend                          |

---

## Running tests

```sh
npm --workspace lib/rlm test
```

70 tests covering REPL tool behavior, runner termination paths, loop detection, corpus index ranking, observability events, trace formatting, and full mock-adapter integration runs.
