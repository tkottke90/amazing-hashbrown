# API reference — `@tkottke90/inference-adapter`

All public exports, organized by category. Import everything from the package root:

```ts
import { OllamaInferenceAdapter, NullInferenceAdapter } from '@tkottke90/inference-adapter';
import type {
  Message,
  ToolCall,
  InferenceAdapter,
  EmbeddingAdapter,
} from '@tkottke90/inference-adapter';
```

---

## Message types

### `Message`

The fundamental unit of a conversation. A discriminated union on the `role` field — TypeScript narrows the available fields based on which role you specify.

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };
```

**Role descriptions:**

| Role          | Used by   | Fields                                                                                                    |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `'system'`    | Developer | `content` — instructions that shape model behavior throughout the conversation. Always the first message. |
| `'user'`      | App user  | `content` — the question or request.                                                                      |
| `'assistant'` | Model     | `content` — the model's reply. `toolCalls` — present when the model is requesting a tool execution.       |
| `'tool'`      | Your code | `results` — an array of tool results, one per tool call in the preceding assistant turn.                  |

**Example conversation history:**

```ts
const history: Message[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: "What's the weather in London?" },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc_0', name: 'get_weather', arguments: { city: 'London' } }],
  },
  {
    role: 'tool',
    results: [{ id: 'tc_0', content: 'Partly cloudy, 15°C' }],
  },
  { role: 'assistant', content: "It's partly cloudy and 15°C in London right now." },
];
```

---

### `ToolCall`

Represents a single function call that the model is requesting your code to execute.

```ts
interface ToolCall {
  id?: string; // optional; some backends omit it
  name: string; // the tool name, matching a ToolDefinition
  arguments: Record<string, unknown>; // parsed argument values, keyed by parameter name
}
```

`id` is optional because some inference backends (including Ollama) do not always include it. When correlating a `ToolCall` to its `ToolResult`, use the `id` if present; generate a synthetic one if not.

---

### `ToolResult`

The result you return to the model after running a tool.

```ts
interface ToolResult {
  id?: string; // should match the ToolCall.id this result belongs to
  content: string; // the result as a plain string
}
```

---

## Tool definitions

### `ToolDefinition`

Describes a tool that you make available to the model. The `parameters` field is a [Zod](https://zod.dev) schema — this lets you define input validation and TypeScript types in one place.

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
}
```

**Example:**

```ts
import { z } from 'zod';
import type { ToolDefinition } from '@tkottke90/inference-adapter';

const searchTool: ToolDefinition = {
  name: 'search_docs',
  description: 'Search the documentation for a keyword.',
  parameters: z.object({
    query: z.string().describe('The keyword or phrase to search for'),
    maxResults: z.number().optional().describe('Maximum number of results (default 5)'),
  }),
};
```

The adapter converts the Zod schema to the format expected by the backend. Callers who need a plain JSON Schema (e.g. for a REST API) can use `z.toJSONSchema(tool.parameters)` from Zod v4.

---

## Inference adapter

### `InferenceAdapter`

The core interface. All consuming code should depend on this interface, not on any specific class, so that the backend can be swapped without changing the calling code.

```ts
interface InferenceAdapter {
  invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse>;
}
```

**`invoke` parameters:**

| Parameter  | Type                  | Description                                                   |
| ---------- | --------------------- | ------------------------------------------------------------- |
| `messages` | `Message[]`           | The full conversation history, in chronological order.        |
| `options`  | `BaseCompleteOptions` | Optional settings: tools, output schema, sampling parameters. |

**`invoke` return value:** `Promise<InferenceResponse>` — see below.

---

### `InferenceResponse`

The object returned by every `invoke` call.

```ts
interface InferenceResponse {
  message: AssistantMessage; // the model's reply
  toolCalls?: ToolCall[]; // convenience copy of message.toolCalls
  structured?: unknown; // populated when options.schema was provided
}
```

| Field        | Type                    | Description                                                                                                       |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `message`    | `AssistantMessage`      | The model's reply. Always `role: 'assistant'`. Access the text via `response.message.content`.                    |
| `toolCalls`  | `ToolCall[]` (optional) | A convenience copy of `message.toolCalls`. Check either location — they are the same values.                      |
| `structured` | `unknown` (optional)    | The parsed, schema-validated object when `options.schema` was provided. Cast to the inferred Zod type before use. |

---

### `AssistantMessage`

The type of `InferenceResponse.message`. Narrower than the full `Message` union — always has `role: 'assistant'` and `content`.

```ts
interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
}
```

---

## Invocation options

### `BaseCompleteOptions`

Options accepted by `InferenceAdapter.invoke`. Extends `BaseSamplingParams`.

```ts
interface BaseCompleteOptions extends BaseSamplingParams {
  tools?: ToolDefinition[]; // tools the model may call
  schema?: z.ZodType; // request structured output matching this schema
}
```

Pass an empty `tools` array (or omit it) to disable tool calling for that call — this is useful for synthesis calls where you want a plain-text response only.

---

### `ExtendedCompleteOptions`

Like `BaseCompleteOptions` but adds `topK`, for backends that support it (Ollama, Anthropic). Used by `OllamaInferenceAdapter`.

```ts
interface ExtendedCompleteOptions extends SamplingParamsWithTopK {
  tools?: ToolDefinition[];
  schema?: z.ZodType;
}
```

---

## Sampling parameters

These control how the model generates text. All fields are optional — omit them to use the model's defaults.

### `BaseSamplingParams`

```ts
interface BaseSamplingParams {
  temperature?: number; // 0.0–2.0; lower = more focused, higher = more creative (default: model default)
  topP?: number; // nucleus sampling threshold 0.0–1.0; keeps the smallest set of tokens whose cumulative probability exceeds topP
  maxTokens?: number; // stop generating after this many tokens
}
```

**What each parameter does:**

- **`temperature`** — Controls randomness. At `0.0` the model always picks the most likely next word; at `2.0` it picks very unpredictably. Values around `0.2–0.7` work well for factual tasks; `0.7–1.0` for creative writing.
- **`topP`** — Another randomness control that works differently from temperature. At `0.9`, the model considers only the words that account for the top 90% of probability, ignoring very unlikely options.
- **`maxTokens`** — A hard cap on response length. One token is roughly 4 characters of English text.

### `SamplingParamsWithTopK`

Extends `BaseSamplingParams` with `topK`:

```ts
interface SamplingParamsWithTopK extends BaseSamplingParams {
  topK?: number; // consider only the top-K most likely next tokens at each step
}
```

**`topK`** — At each step, the model considers only the `topK` most likely next words. Useful for constraining generations from models that tend to ramble. Ollama and Anthropic support this parameter.

---

## Embedding adapter

### `EmbeddingAdapter`

The interface for turning text into numeric vectors. Used by sibling packages for semantic search.

```ts
interface EmbeddingAdapter {
  readonly model: string; // identifies which model produced the embeddings
  embed(texts: string[]): Promise<number[][]>; // batch texts → parallel vectors
}
```

**`embed` contract:**

- Accepts an array of strings (batch for efficiency).
- Returns a parallel array of float vectors — `result[i]` is the vector for `texts[i]`.
- All vectors in a batch must have the same length (the "embedding dimension" of the model).
- The `model` property identifies which model produced the embeddings. Consumers (like `@tkottke90/llm-wiki`) use this to detect when the model has changed and the stored index needs to be rebuilt.

This package defines the `EmbeddingAdapter` interface but does not ship a concrete implementation. See sibling packages:

- `@tkottke90/rlm/adapters` — `OllamaEmbeddingAdapter`
- `@tkottke90/llm-wiki/providers` — `OllamaEmbeddingProvider`, `OpenAIEmbeddingProvider`, `AnthropicEmbeddingProvider`, `NullEmbeddingProvider`

---

## Concrete adapters

### `OllamaInferenceAdapter`

Connects to a locally-running [Ollama](https://ollama.com) server. Uses LangChain's `ChatOllama` internally.

```ts
import { OllamaInferenceAdapter } from '@tkottke90/inference-adapter';

const adapter = new OllamaInferenceAdapter({
  model: 'qwen3:8b',
  baseUrl: 'http://localhost:11434', // optional; defaults to http://localhost:11434
});
```

**Constructor options** (`{ model, baseUrl? }`):

| Option    | Type     | Required | Description                                                    |
| --------- | -------- | -------- | -------------------------------------------------------------- |
| `model`   | `string` | Yes      | Model name as known to Ollama, e.g. `'qwen3:8b'`, `'mistral'`. |
| `baseUrl` | `string` | No       | Ollama server base URL. Defaults to `http://localhost:11434`.  |

**Three operating modes** — selected automatically based on `options`:

| When                                 | What happens                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `options.schema` is provided         | Structured output mode: calls `model.withStructuredOutput(schema)`. Parsed result in `response.structured`; JSON string in `response.message.content`. |
| `options.tools` is a non-empty array | Tool calling mode: calls `model.bindTools(tools)`. Tool calls land in `response.toolCalls` (and `response.message.toolCalls`).                         |
| Neither                              | Plain text mode: bare `model.invoke()`. Response text in `response.message.content`.                                                                   |

**Sampling parameter mapping:**

| `ExtendedCompleteOptions` field | Ollama parameter |
| ------------------------------- | ---------------- |
| `temperature`                   | `temperature`    |
| `topP`                          | `topP`           |
| `topK`                          | `topK`           |
| `maxTokens`                     | `numPredict`     |

> **Note:** The `'system'` role in the `Message` union is not currently handled by `OllamaInferenceAdapter`'s internal message converter. System messages passed in the `messages` array will be silently ignored. Use the system prompt as a `ChatOllama` constructor option if you need system-level instructions via this adapter.

---

### `NullInferenceAdapter`

A no-op adapter that always returns an empty assistant message. Accepts all arguments and ignores them.

```ts
import { NullInferenceAdapter } from '@tkottke90/inference-adapter';

const adapter = new NullInferenceAdapter();
const response = await adapter.invoke([{ role: 'user', content: 'anything' }]);
// response.message.content === ''
// response.toolCalls === undefined
```

**Use cases:**

- Unit tests where you only need to verify the calling code, not the model's response.
- CI pipelines where no LLM is available.
- Placeholder during development before a real adapter is configured.

For scripted test responses (the adapter returns different things on each call), implement a small custom stub — see [docs/custom-adapters.md](./custom-adapters.md#testing-with-stub-adapters).

---

## Full exports table

| Export                    | Kind      | Description                                                                            |
| ------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `Message`                 | type      | Discriminated union of all four message roles.                                         |
| `ToolCall`                | interface | A function call the model is requesting.                                               |
| `ToolResult`              | interface | Your code's response to a `ToolCall`.                                                  |
| `ToolDefinition`          | interface | A tool you make available to the model (Zod schema required).                          |
| `BaseSamplingParams`      | interface | `temperature`, `topP`, `maxTokens`.                                                    |
| `SamplingParamsWithTopK`  | interface | Extends `BaseSamplingParams` with `topK`.                                              |
| `BaseCompleteOptions`     | interface | `tools`, `schema`, plus `BaseSamplingParams`.                                          |
| `ExtendedCompleteOptions` | interface | `tools`, `schema`, plus `SamplingParamsWithTopK`.                                      |
| `AssistantMessage`        | interface | The `role: 'assistant'` variant of `Message`, narrowed for use in `InferenceResponse`. |
| `InferenceResponse`       | interface | The return value of `invoke`.                                                          |
| `InferenceAdapter`        | interface | The single-method interface every adapter must implement.                              |
| `EmbeddingAdapter`        | interface | Interface for text-to-vector embedding backends.                                       |
| `OllamaInferenceAdapter`  | class     | Concrete adapter for Ollama inference via LangChain.                                   |
| `NullInferenceAdapter`    | class     | No-op stub adapter for tests and CI.                                                   |
