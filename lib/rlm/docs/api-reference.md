# API reference — `@tkottke90/rlm`

All public symbols, organized by import path.

---

## Main package — `@tkottke90/rlm`

### `RLMRunner`

The primary entry point. Orchestrates the retrieval loop for a single query.

```ts
import { RLMRunner } from '@tkottke90/rlm';

const runner = new RLMRunner(adapter, embeddingAdapter, config, logger);
const result = await runner.run(query, corpus, onStatus);
```

**Constructor parameters**

| Parameter          | Type                 | Required | Description                                                                            |
| ------------------ | -------------------- | -------- | -------------------------------------------------------------------------------------- |
| `adapter`          | `InferenceAdapter`   | Yes      | LLM inference backend. Implement this interface or use `OllamaAdapter`.                |
| `embeddingAdapter` | `EmbeddingAdapter`   | No       | If provided, adds the `search` tool to the model's tool set. Pass `undefined` to omit. |
| `config`           | `Partial<RLMConfig>` | No       | Overrides for any `DEFAULT_CONFIG` fields.                                             |
| `logger`           | `RLMLogger`          | No       | Receives real-time events and/or the completed trace.                                  |

Both `InferenceAdapter` and `EmbeddingAdapter` are defined in `@tkottke90/inference-adapter` and re-exported from this package. See the [inference-adapter docs](../../inference-adapter/docs/api-reference.md) for the full interface specification.

**`run(query, corpus, onStatus?)`**

| Parameter  | Type             | Description                                                                |
| ---------- | ---------------- | -------------------------------------------------------------------------- |
| `query`    | `string`         | The question to answer from the corpus.                                    |
| `corpus`   | `RLMCorpus`      | The text to search, plus optional metadata.                                |
| `onStatus` | `StatusCallback` | Optional; fires a `StatusSignal` on each tool dispatch (before execution). |

Returns `Promise<RLMResult>`.

---

### `RLMConfig`

Configuration for the retrieval loop. Pass a partial object to `RLMRunner` — unset fields use `DEFAULT_CONFIG` values.

| Field             | Type               | Default      | Description                                                                                                                                                                                                        |
| ----------------- | ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`           | `string`           | `'qwen3:8b'` | Model identifier passed to the adapter. Must match the model name known to your backend.                                                                                                                           |
| `maxIterations`   | `number`           | `10`         | Maximum number of model calls before the synthesis fallback fires.                                                                                                                                                 |
| `maxResultTokens` | `number`           | `2000`       | Passed to the adapter; hints the max response length.                                                                                                                                                              |
| `maxSliceLines`   | `number`           | `200`        | Hard cap on `slice` line range. Over-cap requests receive an error message that steers the model to `summarize`.                                                                                                   |
| `think`           | `boolean`          | `false`      | Enable thinking mode (e.g. `enable_thinking` for Qwen3). **Strongly recommended to keep `false`** — thinking mode doubles median latency with no quality gain for retrieval tasks and can exceed gateway timeouts. |
| `promptAddendum`  | `string`           | —            | Extra text appended to the system prompt. Use to add domain-specific instructions.                                                                                                                                 |
| `extraTools`      | `ToolDefinition[]` | —            | Additional tools to expose to the model alongside the built-in REPL tools.                                                                                                                                         |
| `traceDetail`     | `TraceDetail`      | `'full'`     | Controls how much content is stored in trace events. See [observability.md](./observability.md).                                                                                                                   |

**`DEFAULT_CONFIG`**

```ts
import { DEFAULT_CONFIG } from '@tkottke90/rlm';
// { model: 'qwen3:8b', maxIterations: 10, maxResultTokens: 2000,
//   maxSliceLines: 200, think: false, traceDetail: 'full' }
```

---

### `RLMCorpus`

```ts
interface RLMCorpus {
  text: string;
  source?: string;
  provenance?: ProvenanceStore;
}
```

| Field        | Description                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `text`       | The full corpus string. The RLM module never modifies or re-reads this after the run starts.           |
| `source`     | Short label used in traces, logs, and `formatTrace` output. Recommended.                               |
| `provenance` | Optional `ProvenanceStore` instance. When set, adds the `get_provenance` tool to the model's tool set. |

---

### `RLMResult`

Returned by `runner.run()`.

| Field                | Type                | Description                                                                             |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `answer`             | `string`            | The model's answer. Empty when `found` is `false` and termination was `not_found_tool`. |
| `found`              | `boolean`           | `true` on `final_tool` or `no_tool_call`; `false` on `not_found_tool`.                  |
| `iterations`         | `number`            | Total model calls (including terminal call).                                            |
| `terminationReason`  | `TerminationReason` | `'final_tool'` \| `'not_found_tool'` \| `'no_tool_call'` \| `'max_iterations'`          |
| `toolCallTrace`      | `ToolCallRecord[]`  | Retrieval tool calls in order. Terminal tools excluded.                                 |
| `loopDetectionFired` | `boolean`           | `true` if the runner injected a loop-break message during the run.                      |
| `totalDurationMs`    | `number`            | Wall-clock duration of the entire run.                                                  |
| `events`             | `RLMEvent[]`        | Full ordered event stream. See [observability.md](./observability.md).                  |
| `metrics`            | `RLMMetrics`        | Derived run measurements.                                                               |
| `sourcesUsed`        | `SourceRange[]`     | Line ranges actually read (from `slice`, `summarize`, `query`, `peek`).                 |

**`ToolCallRecord`**

```ts
interface ToolCallRecord {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string; // first 200 chars of the result
  durationMs: number;
}
```

**`RLMMetrics`**

| Field                  | Type                     | Description                                                                       |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `modelCallCount`       | `number`                 | Total `invoke()` calls made to the adapter.                                       |
| `totalModelDurationMs` | `number`                 | Cumulative model call time.                                                       |
| `totalToolDurationMs`  | `number`                 | Cumulative tool execution time.                                                   |
| `charsRead`            | `number`                 | Estimated characters actually returned by read tools.                             |
| `coverageRatio`        | `number`                 | `charsRead / corpus.charCount` (capped at 1.0).                                   |
| `peekFirst`            | `boolean`                | `true` when `peek` was the first retrieval tool called (best-practice indicator). |
| `synthesisTriggered`   | `boolean`                | `true` when `max_iterations` was hit and a synthesis call was made.               |
| `toolFrequency`        | `Record<string, number>` | Count of each retrieval tool used. Terminal tools excluded.                       |

**`SourceRange`**

```ts
interface SourceRange {
  tool: 'slice' | 'summarize' | 'query' | 'peek';
  startLine: number;
  endLine: number;
  iteration: number;
}
```

Intermediate tools (`grep`, `search`) are excluded from `sourcesUsed` — they return line numbers but do not read text.

---

### `InferenceAdapter`

The inference seam. Implement this interface to connect any LLM backend.

```ts
interface InferenceAdapter {
  invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse>;
}
```

| Parameter  | Description                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages` | Conversation history in order: system, user, then alternating assistant/tool turns.                                                                                                                                |
| `options`  | Optional: `tools` (expose to the model), `schema` (structured output), and sampling parameters. When `tools` is absent or empty, the model is expected to respond with plain text only (used for synthesis calls). |

**`InferenceResponse`**

```ts
interface InferenceResponse {
  message: AssistantMessage; // the model's reply; always role: 'assistant'
  toolCalls?: ToolCall[]; // convenience copy of message.toolCalls
  structured?: unknown; // populated when options.schema was provided
}
```

Access the model's text via `response.message.content`. Check `response.toolCalls` (or `response.message.toolCalls`) to see if the model called a tool.

See [`@tkottke90/inference-adapter` docs](../../inference-adapter/docs/custom-adapters.md) for a full implementation guide.

---

### `EmbeddingAdapter`

Optional. Implement to enable semantic `search`.

```ts
interface EmbeddingAdapter {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

`embed` receives an array of text strings and must return a parallel array of embedding vectors (floating-point arrays of equal length). The `model` field identifies which model produced the vectors; the runner uses it to detect when the index needs rebuilding.

See [`@tkottke90/inference-adapter` docs](../../inference-adapter/docs/custom-adapters.md#implementing-embeddingadapter) for a full implementation guide.

---

### `RLMLogger`

Optional. Attach to `RLMRunner` to receive events in real-time and/or the complete trace at run end.

```ts
interface RLMLogger {
  onEvent?(event: RLMEvent): void; // fires for each event as it occurs
  onTrace?(trace: RLMTrace): void; // fires once at run completion
}
```

Both methods are optional — implement only what you need. See [observability.md](./observability.md) for the full event reference.

---

### `RLMTrace`

Self-contained audit record emitted to `RLMLogger.onTrace`.

```ts
interface RLMTrace {
  traceId: string; // UUID
  startedAt: string; // ISO 8601
  completedAt: string; // ISO 8601
  query: string;
  corpusMeta: CorpusMeta;
  config: RLMConfig;
  systemPrompt: string; // the exact system prompt sent to the model
  events: RLMEvent[];
  result: RLMResult;
}
```

**`CorpusMeta`** — serializable snapshot of the corpus, without the text itself:

```ts
interface CorpusMeta {
  source?: string;
  charCount: number;
  lineCount: number;
  hasEmbeddings: boolean;
  hasProvenance: boolean;
}
```

---

### `ProvenanceStore`

File-backed JSONL store for recording and looking up provenance entries (source documents, timestamps, claim text).

```ts
import { ProvenanceStore } from '@tkottke90/rlm';

const store = new ProvenanceStore({ path: './data/provenance.jsonl' });
```

**Methods**

| Method   | Signature                                                              | Description                                                                  |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `record` | `(entry: ProvenanceEntry) => Promise<void>`                            | Appends a new provenance entry to the store.                                 |
| `lookup` | `(factText: string) => Promise<ProvenanceEntry[]>`                     | Returns all entries whose `claimText` contains `factText` as a substring.    |
| `stale`  | `(entityId: string, maxAgeDays: number) => Promise<ProvenanceEntry[]>` | Returns entries for `entityId` whose `writtenAt` is older than `maxAgeDays`. |

**`ProvenanceEntry`**

```ts
interface ProvenanceEntry {
  entityId: string; // the entity this fact belongs to
  claimText: string; // canonical verbatim text of the claim
  sourceDocId: string; // identifier of the source document
  sourceType: string; // e.g. "meeting-notes", "email", "wiki-page"
  writtenAt: string; // ISO 8601 timestamp
  supersededBy?: string; // entityId of a newer entry, if this one is outdated
}
```

Attach a `ProvenanceStore` to `corpus.provenance` to enable the `get_provenance` tool. The tool uses `lookup()` (substring match) — for production use, pair it with a vector lookup layer at the application level.

---

### `NoOpEmbeddingAdapter`

Placeholder embedding adapter that always returns empty vectors. Useful in tests and during development before a real embedding model is available.

```ts
import { NoOpEmbeddingAdapter } from '@tkottke90/rlm';

const embedder = new NoOpEmbeddingAdapter();
// embedder.embed(['any text']) → []
```

---

### Utility functions

**`formatTrace(trace: RLMTrace): string`**

Renders a complete trace as a human-readable multi-line string. Suitable for `console.log`, log files, or a `<pre>` block. See [observability.md](./observability.md) for an example of the output.

**`deriveSourcesUsed(events: RLMEvent[]): SourceRange[]`**

Extracts source attribution from a raw event array. Called automatically at the end of each run to populate `result.sourcesUsed`, but can also be called on any saved event array.

**`deriveMetrics(events: RLMEvent[], corpusMeta: CorpusMeta): RLMMetrics`**

Computes the full `RLMMetrics` object from a raw event array. Called automatically at run end to populate `result.metrics`.

---

### Type aliases

| Type                | Definition                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `TerminationReason` | `'final_tool' \| 'not_found_tool' \| 'no_tool_call' \| 'max_iterations'`                                 |
| `IterationPhase`    | `'orientation' \| 'searching' \| 'reading' \| 'summarizing' \| 'querying' \| 'answering' \| 'not_found'` |
| `TraceDetail`       | `'full' \| 'compact' \| 'minimal'`                                                                       |
| `StatusCallback`    | `(signal: StatusSignal) => void`                                                                         |
| `RLMEvent`          | Discriminated union of all ten event interfaces.                                                         |

---

## The nine REPL tools

These tools are exposed to the model automatically. You do not call them directly — the model calls them during the retrieval loop.

| Tool             | Arguments                             | Available when                      | Returns                                      | Notes                                                                                                                                            |
| ---------------- | ------------------------------------- | ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `peek`           | `chars?` (default 2000)               | Always                              | First N characters of the corpus             | The model should call this first to orient itself.                                                                                               |
| `grep`           | `pattern`, `maxResults?` (default 50) | Always                              | Matching lines with line numbers             | Case-insensitive regex. Results include line numbers so the model can target `slice`. Invalid regex returns an error message.                    |
| `slice`          | `startLine`, `endLine`                | Always                              | Numbered line range                          | Hard cap at `maxSliceLines` (default 200). Over-cap requests receive an error message that steers the model to `summarize`.                      |
| `summarize`      | `startLine`, `endLine`, `focus?`      | Always                              | Summary string                               | Spawns a fresh model sub-call scoped to the target range. "NOT FOUND IN THIS RANGE" means absent from that range only, not from the full corpus. |
| `query`          | `question`, `startLine`, `endLine`    | Always                              | Answer string                                | Like `summarize` but framed as a direct question. Returns "NOT FOUND IN THIS RANGE" when the answer is absent from the target range.             |
| `search`         | `query`, `topK?` (default 5)          | When `embeddingAdapter` is provided | Candidate line ranges with similarity scores | Semantic search. The model should always `slice` a result before answering from it.                                                              |
| `get_provenance` | `fact`                                | When `corpus.provenance` is set     | Source document, type, timestamp             | Uses substring lookup. Production use may require a vector lookup layer for paraphrase matching.                                                 |
| `not_found`      | `searched`                            | Always                              | (terminal — ends the loop)                   | The model calls this when it has genuinely exhausted its search. Sets `result.found = false` and `terminationReason = 'not_found_tool'`.         |
| `final_answer`   | `content`                             | Always                              | (terminal — ends the loop)                   | The model calls this with its synthesized answer. Sets `result.answer = content` and `terminationReason = 'final_tool'`.                         |

---

## Adapters — `@tkottke90/rlm/adapters`

### `OllamaAdapter`

Implements `InferenceAdapter` for the [Ollama](https://ollama.com) local server using direct HTTP calls to Ollama's `/api/chat` endpoint. Handles three observed tool-call wire formats automatically.

```ts
import { OllamaAdapter } from '@tkottke90/rlm/adapters';

const adapter = new OllamaAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:8b',
  think: false,
});
```

**Constructor options**

| Option       | Type      | Default | Description                                                                                          |
| ------------ | --------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `baseUrl`    | `string`  | —       | Ollama server base URL. Trailing slash is stripped automatically.                                    |
| `model`      | `string`  | —       | Model name as known to Ollama (e.g. `'qwen3:8b'`, `'mistral'`).                                      |
| `think`      | `boolean` | `false` | Passes `enable_thinking: true` to Ollama's `chat_template_kwargs`. Keep `false` for retrieval tasks. |
| `retryOn5xx` | `boolean` | `true`  | Automatically retries once on HTTP 5xx responses from Ollama.                                        |

**Wire format handling**

`OllamaAdapter` parses tool calls from three formats produced by different models under different conditions:

1. **Native structured** — `message.tool_calls` array (Ollama's preferred format)
2. **XML escape** — `<tool_call>{...}</tool_call>` in the content body (Qwen3 under context pressure)
3. **Bare JSON array** — `[{"name": "...", "arguments": {...}}]` in the content body (Mistral 7B)

**Think-block stripping**

`<think>...</think>` blocks are stripped from the response content automatically.

---

### `OllamaEmbeddingAdapter`

Implements `EmbeddingAdapter` using Ollama's `/api/embed` endpoint.

```ts
import { OllamaEmbeddingAdapter } from '@tkottke90/rlm/adapters';

const embedder = new OllamaEmbeddingAdapter({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});
```

**Constructor options**

| Option    | Type     | Description                                                              |
| --------- | -------- | ------------------------------------------------------------------------ |
| `baseUrl` | `string` | Ollama server base URL.                                                  |
| `model`   | `string` | Embedding model name (e.g. `'nomic-embed-text'`, `'mxbai-embed-large'`). |

Pull an embedding model before use:

```sh
ollama pull nomic-embed-text
```
