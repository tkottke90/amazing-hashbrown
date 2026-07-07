# Custom adapters — connecting any LLM backend

`@tkottke90/rlm` has no built-in inference. You plug in your own model backend by implementing the `ModelAdapter` interface. This makes the library compatible with any LLM API — OpenAI-compatible endpoints, Anthropic, local vLLM, custom inference servers, or a mock for testing.

---

## When to implement a custom `ModelAdapter`

- You're using a model or API not served by Ollama.
- You need to customize headers, auth, or request shaping for your endpoint.
- You're writing tests and want a scripted adapter that returns fixed responses.
- You want to route different parts of the loop to different models.

---

## The `ModelAdapter` interface

```ts
interface ModelAdapter {
  complete(messages: Message[], tools: Tool[], config: RLMConfig): Promise<ModelResponse>;
}
```

**`messages`** — the full conversation history in order:

| Position   | Role                     | Content                                                               |
| ---------- | ------------------------ | --------------------------------------------------------------------- |
| First      | `'system'`               | System prompt built by the runner (corpus metadata, instructions).    |
| Second     | `'user'`                 | The query.                                                            |
| Subsequent | `'assistant'` / `'tool'` | Alternating assistant turns (with `toolCalls`) and tool result turns. |

**`tools`** — array of JSON Schema tool definitions. The runner passes an empty array when it wants a plain-text synthesis response (no tool calls allowed).

**`config`** — the runner's `RLMConfig`. `config.model` is the model identifier; `config.maxResultTokens` is a hint for max response length; `config.think` signals whether extended thinking should be enabled.

**`ModelResponse`**

```ts
interface ModelResponse {
  content: string; // post-processed text (think blocks stripped, if applicable)
  rawContent: string; // verbatim text from the wire, before any post-processing
  toolCalls: ToolCall[]; // parsed tool calls; empty array when model responded with plain text
  durationMs: number; // elapsed time for this completion call, for metrics
}
```

- **`content`** is what the runner uses. If your model produces `<think>...</think>` blocks, strip them and put the result here.
- **`rawContent`** is the unmodified wire content. The runner stores it in `model_responded` events for audit purposes. If you don't strip anything, set `rawContent = content`.
- **`toolCalls`** must be empty (`[]`) when the model responded with plain text, not a tool call.

---

## Example: OpenAI-compatible chat completion API

This example targets any endpoint that accepts the standard OpenAI chat format and returns tool calls in the `choices[0].message.tool_calls` array.

```ts
import type {
  ModelAdapter,
  ModelResponse,
  Message,
  Tool,
  ToolCall,
  RLMConfig,
} from '@tkottke90/rlm';

interface OpenAIToolCall {
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message: {
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async complete(messages: Message[], tools: Tool[], config: RLMConfig): Promise<ModelResponse> {
    const start = Date.now();

    const body = {
      model: config.model,
      max_tokens: config.maxResultTokens,
      messages: messages.map(toOpenAIMessage),
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const msg = data.choices[0]!.message;
    const rawContent = msg.content ?? '';

    // Parse tool calls from the structured tool_calls array
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: rawContent, // no think-block stripping needed for this API
      rawContent,
      toolCalls,
      durationMs: Date.now() - start,
    };
  }
}

// Convert RLM's Message format to OpenAI's format
function toOpenAIMessage(m: Message): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    base['tool_calls'] = m.toolCalls.map((tc) => ({
      id: tc.name,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  if (m.role === 'tool') {
    base['tool_call_id'] = m.toolName;
  }
  return base;
}

// Convert RLM's Tool format to OpenAI's format
function toOpenAITool(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
```

Use it exactly like `OllamaAdapter`:

```ts
const adapter = new OpenAICompatibleAdapter('https://api.openai.com', process.env.OPENAI_API_KEY!);
const runner = new RLMRunner(adapter, undefined, { model: 'gpt-4o-mini', think: false });
```

---

## Tool call parsing

The runner passes `tools` as an array of standard JSON Schema definitions. What it expects back in `toolCalls` is:

```ts
interface ToolCall {
  name: string; // exact tool name as defined in the tools array
  args: Record<string, unknown>; // parsed argument object (not a JSON string)
}
```

If your API returns `arguments` as a JSON string (as OpenAI does), parse it before returning. If your model sometimes returns tool calls in the content body as a text format, parse them there. The runner does not retry or recover from malformed tool calls — it sees an empty `toolCalls` array and treats the response as plain text.

---

## Think-block handling

Some models (Qwen3, DeepSeek-R1) produce extended reasoning inside `<think>...</think>` tags before their final answer or tool call. The model's own content after the block is what the runner should see.

```ts
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// In your complete() method:
const rawContent = msg.content ?? '';
const content = stripThinkBlocks(rawContent);

return {
  content, // ← stripped: what the runner uses
  rawContent, // ← original: preserved for audit traces
  toolCalls,
  durationMs: Date.now() - start,
};
```

`OllamaAdapter` does this automatically.

---

## Implementing `RlmEmbeddingAdapter`

The embedding adapter interface is minimal:

```ts
interface RlmEmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}
```

`embed` receives a batch of text strings and must return a parallel array of equal-length float vectors. The return array must have the same length as the input array.

```ts
import type { RlmEmbeddingAdapter } from '@tkottke90/rlm';

export class MyEmbeddingAdapter implements RlmEmbeddingAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: 'text-embedding-3-small' }),
    });
    if (!res.ok) throw new Error(`Embed error ${res.status}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}
```

Pass it as the second argument to `RLMRunner`. When present, the `search` tool is automatically added to the model's tool set.

---

## Testing with stub adapters

For unit and integration tests, use a scripted stub:

```ts
import type { ModelAdapter, ModelResponse } from '@tkottke90/rlm';

// Simplest stub: always returns a plain-text response
const plainTextStub: ModelAdapter = {
  async complete() {
    return { content: 'stub answer', rawContent: 'stub answer', toolCalls: [], durationMs: 0 };
  },
};

// Scripted stub: returns responses from a queue in order
function scriptedAdapter(steps: Partial<ModelResponse>[]): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const base: ModelResponse = { content: '', rawContent: '', toolCalls: [], durationMs: 0 };
      return i < steps.length ? { ...base, ...steps[i++] } : { ...base, content: 'fallback' };
    },
  };
}

// Usage in a test
const adapter = scriptedAdapter([
  { toolCalls: [{ name: 'peek', args: { chars: 500 } }] },
  { toolCalls: [{ name: 'grep', args: { pattern: 'Marcus' } }] },
  { toolCalls: [{ name: 'final_answer', args: { content: 'Marcus Delacroix' } }] },
]);

const runner = new RLMRunner(adapter, undefined, { maxIterations: 10, think: false });
const result = await runner.run('Who leads DataBridge?', corpus);
// result.answer === 'Marcus Delacroix'
// result.terminationReason === 'final_tool'
```

For tests that need an embedding adapter but don't need real embeddings, use `NoOpEmbeddingAdapter`:

```ts
import { NoOpEmbeddingAdapter } from '@tkottke90/rlm';

const runner = new RLMRunner(adapter, new NoOpEmbeddingAdapter(), config);
// The search tool is added to the tool set but will never surface meaningful results
```
