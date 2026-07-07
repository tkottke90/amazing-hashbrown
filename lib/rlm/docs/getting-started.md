# Getting started with `@tkottke90/rlm`

This guide walks you from a fresh environment to a working retrieval-loop query. No prior experience with RLM or Ollama is assumed.

---

## Prerequisites

**Ollama** must be running locally with at least one compatible model pulled.

```sh
# Install Ollama — see https://ollama.com for your platform
ollama serve          # start the server (runs on http://localhost:11434 by default)
ollama pull qwen3:8b  # recommended model; ~5 GB download
```

Qwen3 8B is the recommended starting model. It reliably uses the structured tool-call format and handles the retrieval loop well. The `think: false` option (shown below) is strongly recommended — thinking mode doubles median latency with no quality gain for retrieval tasks.

**Node.js 18 or later** and this monorepo cloned locally.

---

## Build

```sh
# From the repo root — installs all workspace dependencies
npm install

# Build the rlm package
npm run build --workspace lib/rlm
```

In development, other workspaces in this monorepo can import `@tkottke90/rlm` via the workspace symlink without a prior build step if they use `tsx`.

---

## Preparing a corpus

A **corpus** is a plain string — whatever text you want the model to search through. You decide what goes in it.

```ts
import { readFileSync } from 'node:fs';
import type { RLMCorpus } from '@tkottke90/rlm';

// Simplest case: one file
const corpus: RLMCorpus = {
  text: readFileSync('./notes/wiki.md', 'utf8'),
  source: 'personal-wiki', // shown in traces and logs; use a short descriptive label
};

// Multiple files: concatenate them yourself
const corpus: RLMCorpus = {
  text: [
    readFileSync('./notes/people.md', 'utf8'),
    readFileSync('./notes/projects.md', 'utf8'),
  ].join('\n\n---\n\n'),
  source: 'personal-wiki',
};
```

**Practical size target:** 40,000–120,000 characters. Below ~24 K chars, a direct streaming call may be faster. Above ~200 K chars, consider splitting into multiple corpora and routing between them at the application layer.

The `source` label is optional but strongly recommended — it appears in traces, status signals, and `formatTrace` output, making logs much easier to read.

---

## Running your first query

```ts
import { RLMRunner } from '@tkottke90/rlm';
import { OllamaAdapter } from '@tkottke90/rlm/adapters';
import { readFileSync } from 'node:fs';

const adapter = new OllamaAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:8b',
});

const runner = new RLMRunner(adapter, undefined, { think: false });

const corpus = {
  text: readFileSync('./notes/wiki.md', 'utf8'),
  source: 'personal-wiki',
};

const result = await runner.run('Who is the lead engineer on DataBridge?', corpus);

console.log('Found:', result.found);
console.log('Answer:', result.answer);
console.log('Iterations:', result.iterations);
console.log('Terminated via:', result.terminationReason);
```

The runner keeps the full corpus out of the model's context. Instead, it gives the model a set of read tools (`peek`, `grep`, `slice`, etc.) and loops until the model calls `final_answer` or `not_found`.

---

## Reading the result

`runner.run()` returns an `RLMResult` object:

| Field                | Type                | Description                                                                      |
| -------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `answer`             | `string`            | The model's answer. Empty string when `found` is `false`.                        |
| `found`              | `boolean`           | `true` when the model called `final_answer`; `false` when it called `not_found`. |
| `iterations`         | `number`            | Total number of model calls made (including the final call).                     |
| `terminationReason`  | `TerminationReason` | Why the loop ended.                                                              |
| `toolCallTrace`      | `ToolCallRecord[]`  | Ordered log of retrieval tool calls (excludes terminal tools).                   |
| `loopDetectionFired` | `boolean`           | `true` if the runner injected a loop-break message.                              |
| `totalDurationMs`    | `number`            | Wall-clock duration of the entire run.                                           |
| `events`             | `RLMEvent[]`        | Full ordered event stream (see [observability.md](./observability.md)).          |
| `metrics`            | `RLMMetrics`        | Derived measurements (model calls, chars read, tool frequency, etc.).            |
| `sourcesUsed`        | `SourceRange[]`     | Line ranges that were actually read (slice/summarize/query/peek).                |

### Termination reasons

| `terminationReason` | Meaning                                                                                           | `found` |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `'final_tool'`      | Model called `final_answer` — the normal success path.                                            | `true`  |
| `'not_found_tool'`  | Model called `not_found` — genuinely searched and gave up honestly.                               | `false` |
| `'no_tool_call'`    | Model returned plain text without calling any tool. `answer` holds that text.                     | `true`  |
| `'max_iterations'`  | Loop hit the `maxIterations` ceiling. A synthesis prompt is sent to extract a best-effort answer. | `true`  |

### The tool call trace

`toolCallTrace` records every retrieval tool call in order. Terminal tools (`final_answer`, `not_found`) are excluded — they are signals, not retrievals.

```ts
for (const call of result.toolCallTrace) {
  console.log(
    `[iter ${call.iteration}] ${call.tool}(${JSON.stringify(call.args)})  ${call.durationMs}ms`,
  );
  console.log('  preview:', call.resultPreview);
}
// [iter 1] peek({"chars":500})  12ms
// [iter 2] grep({"pattern":"Marcus"})  3ms
// [iter 3] slice({"startLine":5,"endLine":7})  2ms
```

---

## Adding semantic search

When you provide an `OllamaEmbeddingAdapter`, the runner automatically adds a `search` tool that the model can use to find passages by meaning rather than exact keyword. No other changes are needed.

```ts
import { RLMRunner } from '@tkottke90/rlm';
import { OllamaAdapter, OllamaEmbeddingAdapter } from '@tkottke90/rlm/adapters';

const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434', model: 'qwen3:8b' });
const embedder = new OllamaEmbeddingAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});

const runner = new RLMRunner(adapter, embedder, { think: false });
```

Pull the embedding model first:

```sh
ollama pull nomic-embed-text
```

The index is built from the corpus text before the first model call. The `search` tool returns candidate line ranges; the model then reads them with `slice` before answering.

---

## Showing progress in a UI

Pass a `StatusCallback` as the third argument to `runner.run()`. It fires on every tool dispatch — before the tool executes — giving you a stream of human-readable status messages.

```ts
const result = await runner.run(query, corpus, (signal) => {
  // Update your UI here, e.g. setStatusMessage(signal.message)
  console.log(`[${signal.phase}] ${signal.message}`);
});
// [orientation] Checking your memory...
// [searching] Searching your memory...
// [reading] Reading relevant section...
```

The `StatusSignal` object:

| Field       | Type                  | Description                                                  |
| ----------- | --------------------- | ------------------------------------------------------------ |
| `phase`     | `IterationPhase`      | Machine-readable phase label.                                |
| `message`   | `string`              | Human-readable status string, suitable for display directly. |
| `iteration` | `number`              | Which iteration this signal is from.                         |
| `tool`      | `string \| undefined` | The tool name being called.                                  |

### Phase labels and their messages

| `phase`         | `message`                                      | Triggered by     |
| --------------- | ---------------------------------------------- | ---------------- |
| `'orientation'` | `"Checking your memory..."`                    | `peek`           |
| `'searching'`   | `"Searching your memory..."`                   | `grep`           |
| `'searching'`   | `"Searching for relevant context..."`          | `search`         |
| `'reading'`     | `"Reading relevant section..."`                | `slice`          |
| `'reading'`     | `"Looking up the source of that..."`           | `get_provenance` |
| `'summarizing'` | `"Reviewing a longer section..."`              | `summarize`      |
| `'querying'`    | `"Checking a specific part of your memory..."` | `query`          |

Terminal tools (`final_answer`, `not_found`) do not fire a `StatusSignal`.

---

## Next steps

- **[api-reference.md](./api-reference.md)** — complete reference for all public classes, interfaces, functions, and the nine REPL tools
- **[observability.md](./observability.md)** — event stream, `RLMLogger`, `formatTrace`, and how to build a live-updating UI from `correlationId` pairs
- **[custom-adapters.md](./custom-adapters.md)** — implementing `ModelAdapter` and `RlmEmbeddingAdapter` for any LLM backend (OpenAI-compatible APIs, Anthropic, vLLM, etc.)
