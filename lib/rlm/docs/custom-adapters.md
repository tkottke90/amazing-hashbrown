# Custom adapters — connecting any LLM backend

`@tkottke90/rlm` has no built-in inference. You plug in your own model backend by implementing the `InferenceAdapter` interface from `@tkottke90/inference-adapter`. This makes the library compatible with any LLM API — OpenAI-compatible endpoints, Anthropic, local vLLM, custom inference servers, or a mock for testing.

---

## When to implement a custom `InferenceAdapter`

- You're using a model or API not served by Ollama.
- You need to customize headers, authentication, or request shaping for your endpoint.
- You're writing tests and want a scripted adapter that returns fixed responses.
- You want to route different parts of the loop to different models.

---

## The `InferenceAdapter` interface

```ts
interface InferenceAdapter {
  invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse>;
}
```

**`messages`** — the full conversation history in order:

| Position   | Role                     | Content                                                               |
| ---------- | ------------------------ | --------------------------------------------------------------------- |
| First      | `'system'`               | System prompt built by the runner (corpus metadata, instructions).    |
| Second     | `'user'`                 | The query.                                                            |
| Subsequent | `'assistant'` / `'tool'` | Alternating assistant turns (with `toolCalls`) and tool result turns. |

**`options`** — optional settings for this call:

| Field | Description |
|---|---|
| `tools` | `ToolDefinition[]` — tools to expose to the model. An absent or empty array signals a synthesis call: the model should respond with plain text only, no tool calls. |
| `schema` | A Zod schema for structured output mode. |
| `temperature`, `topP`, `maxTokens` | Sampling parameters (see `BaseSamplingParams`). |

**`InferenceResponse`**

```ts
interface InferenceResponse {
  message: AssistantMessage; // always role: 'assistant'
  toolCalls?: ToolCall[];    // present when the model called a tool
  structured?: unknown;      // present when options.schema was provided
}

interface AssistantMessage {
  role: 'assistant';
  content: string;            // the model's text (post-processing applied)
  toolCalls?: ToolCall[];     // same as InferenceResponse.toolCalls
}
```

Access the model's text via `response.message.content`. Tool calls are available both at `response.toolCalls` and `response.message.toolCalls` — they are the same values.

---

## Example: OpenAI-compatible chat completion API

This example targets any endpoint that accepts the standard OpenAI chat format and returns tool calls in the `choices[0].message.tool_calls` array.

```ts
import type {
  InferenceAdapter,
  InferenceResponse,
  Message,
  ToolCall,
  ToolDefinition,
  BaseCompleteOptions,
} from '@tkottke90/rlm';
import { z } from 'zod';

// Internal types for the OpenAI wire format
interface OpenAIWireToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAIWireMessage {
  content: string | null;
  tool_calls?: OpenAIWireToolCall[];
}

interface OpenAIWireResponse {
  choices: Array<{ message: OpenAIWireMessage }>;
}

export class OpenAICompatibleAdapter implements InferenceAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse> {
    const tools = options?.tools ?? [];

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      top_p: options?.topP,
      messages: messages.map(toOpenAIMessage),
    };

    // Only include the tools field when tool calling is requested
    if (tools.length > 0) {
      body['tools'] = tools.map(toOpenAITool);
    }

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

    const data = (await res.json()) as OpenAIWireResponse;
    const msg = data.choices[0]!.message;
    const content = msg.content ?? '';

    // Parse tool calls; OpenAI returns `arguments` as a JSON string — parse it
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      message: {
        role: 'assistant',
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

// Convert from this package's Message type to OpenAI's wire format
function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    // OpenAI expects one message per tool result
    return m.results.map((r) => ({
      role: 'tool',
      tool_call_id: r.id ?? '',
      content: r.content,
    }));
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id ?? '',
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

// Convert from this package's ToolDefinition to OpenAI's wire format
function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    },
  };
}
```

Use it exactly like `OllamaAdapter`:

```ts
const adapter = new OpenAICompatibleAdapter(
  'https://api.openai.com',
  process.env.OPENAI_API_KEY!,
  'gpt-4o-mini',
);
const runner = new RLMRunner(adapter, undefined, { think: false });
```

---

## Tool call parsing

The runner passes `options.tools` as an array of `ToolDefinition` objects. What you return in `toolCalls` is:

```ts
interface ToolCall {
  id?: string;                        // correlates back to a tool result; optional
  name: string;                       // exact tool name as defined in the tools array
  arguments: Record<string, unknown>; // parsed argument object (not a JSON string)
}
```

If your API returns `arguments` as a JSON string (as OpenAI does), parse it before returning. If your model sometimes returns tool calls embedded in the content body as text (Qwen3 and Mistral 7B both do this under context pressure), parse them there.

The runner does not retry or recover from malformed tool calls — if `toolCalls` is absent or empty, it treats the response as a plain-text answer.

---

## Think-block handling

Some models (Qwen3, DeepSeek-R1) produce extended reasoning inside `<think>...</think>` tags before their final answer or tool call. Strip these from `content` before returning:

```ts
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// In your invoke() method:
const rawContent = msg.content ?? '';
const content = stripThinkBlocks(rawContent);

return {
  message: { role: 'assistant', content },
  toolCalls,
};
```

`OllamaAdapter` does this automatically.

---

## Implementing `EmbeddingAdapter`

The embedding adapter interface is minimal:

```ts
interface EmbeddingAdapter {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

`embed` receives a batch of text strings and must return a parallel array of equal-length float vectors. The return array must have the same length as the input array. The `model` property should be a stable string that identifies the embedding model being used.

```ts
import type { EmbeddingAdapter } from '@tkottke90/rlm';

export class MyEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    model = 'text-embedding-3-small',
  ) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
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
import type { InferenceAdapter, InferenceResponse } from '@tkottke90/rlm';

// Simplest stub: always returns a plain-text response
const plainTextStub: InferenceAdapter = {
  async invoke(): Promise<InferenceResponse> {
    return { message: { role: 'assistant', content: 'stub answer' } };
  },
};

// Scripted stub: returns responses from a queue in order
function scriptedAdapter(steps: Partial<InferenceResponse>[]): InferenceAdapter {
  let i = 0;
  return {
    async invoke(): Promise<InferenceResponse> {
      const base: InferenceResponse = { message: { role: 'assistant', content: '' } };
      return i < steps.length ? { ...base, ...steps[i++] } : base;
    },
  };
}

// Usage in a test — note: toolCalls use `arguments`, not `args`
const adapter = scriptedAdapter([
  { toolCalls: [{ name: 'peek', arguments: { chars: 500 } }] },
  { toolCalls: [{ name: 'grep', arguments: { pattern: 'Marcus' } }] },
  { toolCalls: [{ name: 'final_answer', arguments: { content: 'Marcus Delacroix' } }] },
]);

const runner = new RLMRunner(adapter, undefined, { maxIterations: 10, think: false });
const result = await runner.run('Who leads DataBridge?', corpus);
// result.answer === 'Marcus Delacroix'
// result.terminationReason === 'final_tool'
```

### Detecting synthesis calls

The runner calls `invoke` without tools when it needs a plain-text synthesis answer (after hitting `maxIterations`). Detect this in a stub to return the appropriate response:

```ts
import type { InferenceAdapter, InferenceResponse, BaseCompleteOptions, Message } from '@tkottke90/rlm';

const smartStub: InferenceAdapter = {
  async invoke(
    _messages: Message[],
    options?: BaseCompleteOptions,
  ): Promise<InferenceResponse> {
    // Synthesis calls have no tools (or an empty tools array)
    const isSynthesisCall = !options?.tools || options.tools.length === 0;

    if (isSynthesisCall) {
      return { message: { role: 'assistant', content: 'Synthesized best answer.' } };
    }

    return {
      message: { role: 'assistant', content: '' },
      toolCalls: [{ name: 'final_answer', arguments: { content: 'Direct answer.' } }],
    };
  },
};
```

For tests that need an embedding adapter but don't need real embeddings, use `NoOpEmbeddingAdapter`:

```ts
import { NoOpEmbeddingAdapter } from '@tkottke90/rlm';

const runner = new RLMRunner(adapter, new NoOpEmbeddingAdapter(), config);
// The search tool is added to the tool set but will never surface meaningful results
```
