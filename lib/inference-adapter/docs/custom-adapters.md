# Custom adapters — connecting any LLM backend

`@tkottke90/inference-adapter` ships with an Ollama adapter, but the `InferenceAdapter` interface is the real product — it lets you connect any AI backend. This guide walks through implementing one from scratch.

---

## When to write a custom adapter

- You're using a backend not served by Ollama (Anthropic Claude, OpenAI, a company-internal API, a local vLLM server, etc.).
- You need custom headers, authentication, or request shaping.
- You're writing tests and want scripted, deterministic responses.

---

## The `InferenceAdapter` interface

```ts
interface InferenceAdapter {
  invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse>;
}
```

One method. It receives the full conversation history and optional settings, and must return the model's reply as an `InferenceResponse`.

**What `messages` looks like:**

| Position | Role | Content |
|---|---|---|
| First | `'system'` | Instructions you write to set the model's behavior. |
| Second | `'user'` | The user's question or request. |
| Later | `'assistant'` / `'tool'` | Alternating model replies and tool results (if the conversation includes tool calls). |

**What `options` contains:**

| Field | Type | Description |
|---|---|---|
| `tools` | `ToolDefinition[]` (optional) | Tools the model may call. Empty or absent means "respond with plain text only." |
| `schema` | `z.ZodType` (optional) | Request structured output matching this schema. |
| `temperature` | `number` (optional) | Generation randomness (0.0–2.0). |
| `topP` | `number` (optional) | Nucleus sampling threshold. |
| `maxTokens` | `number` (optional) | Maximum tokens to generate. |

**What `InferenceResponse` must contain:**

```ts
interface InferenceResponse {
  message: AssistantMessage;  // required
  toolCalls?: ToolCall[];     // include when the model called a tool
  structured?: unknown;       // include when options.schema was provided
}

interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
}
```

---

## Minimal example: OpenAI-compatible chat API

This adapter works with any API that follows the OpenAI chat completions format — OpenAI itself, compatible open-source proxies, and many hosted models.

```ts
import type {
  InferenceAdapter,
  InferenceResponse,
  Message,
  ToolCall,
  ToolDefinition,
  BaseCompleteOptions,
} from '@tkottke90/inference-adapter';
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
      messages: messages.map(toOpenAIMessage),
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      top_p: options?.topP,
    };

    // Only include tools in the request when the caller wants tool calls
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

    // Parse tool calls from the structured array
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      // OpenAI returns arguments as a JSON string — parse it
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

**Use it like any other adapter:**

```ts
const adapter = new OpenAICompatibleAdapter(
  'https://api.openai.com',
  process.env.OPENAI_API_KEY!,
  'gpt-4o-mini',
);

const response = await adapter.invoke([
  { role: 'user', content: 'What is 2 + 2?' },
]);
console.log(response.message.content); // "4"
```

---

## Tool call parsing

Your `invoke` method receives `options.tools` — the list of tools the model may call. What you return in `toolCalls` must match the `ToolCall` interface:

```ts
interface ToolCall {
  id?: string;                        // correlates to a ToolResult; optional
  name: string;                       // exact name matching a ToolDefinition
  arguments: Record<string, unknown>; // parsed object, not a JSON string
}
```

**Common pitfalls:**

- **`arguments` must be a parsed object, not a string.** If your backend returns arguments as a JSON string (as OpenAI does), call `JSON.parse()` before returning.
- **Empty tool calls means plain text.** If the model responded with text and no tool calls, return `toolCalls: undefined` (or omit the field).
- **No recovery from malformed tool calls.** If your parser fails, the runner that called `invoke` will see `toolCalls: undefined` and treat the response as plain text. Validate and sanitize in your adapter.

---

## Think-block stripping

Some models (Qwen3, DeepSeek-R1) emit extended reasoning inside `<think>...</think>` tags before their answer. Strip these from `content` before returning, because the reasoning text is not the model's actual answer:

```ts
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// In your invoke() method:
const rawContent = msg.content ?? '';
const content = stripThinkBlocks(rawContent);

return {
  message: { role: 'assistant', content },
  // rawContent is not part of the InferenceResponse interface;
  // if you need it for debugging, store it in your adapter or log it
};
```

`OllamaInferenceAdapter` handles this automatically for Ollama's responses.

---

## Implementing `EmbeddingAdapter`

The embedding adapter interface is minimal — batch text in, parallel vectors out:

```ts
interface EmbeddingAdapter {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

**Contract requirements:**
- `result.length` must equal `texts.length`.
- Every vector in `result` must have the same length (the model's embedding dimension).
- `model` must be a stable identifier for the model being used — consumers use it to detect when the model changes and an embedding index needs to be rebuilt.

**Example — OpenAI-compatible embeddings endpoint:**

```ts
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
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
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) throw new Error(`Embed error ${res.status}`);

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };

    // OpenAI returns results in the same order as the input — return the vectors directly
    return data.data.map((d) => d.embedding);
  }
}
```

---

## Testing with stub adapters

### The simplest stub

For tests where the response content doesn't matter:

```ts
import type { InferenceAdapter, InferenceResponse } from '@tkottke90/inference-adapter';

const stub: InferenceAdapter = {
  async invoke(): Promise<InferenceResponse> {
    return { message: { role: 'assistant', content: 'stub response' } };
  },
};
```

### Scripted stub (queue of responses)

For tests that drive a multi-step loop (like `RLMRunner`), return different responses on each call:

```ts
import type { InferenceAdapter, InferenceResponse } from '@tkottke90/inference-adapter';

function scriptedAdapter(steps: Partial<InferenceResponse>[]): InferenceAdapter {
  let i = 0;
  const base: InferenceResponse = { message: { role: 'assistant', content: '' } };
  return {
    async invoke(): Promise<InferenceResponse> {
      return i < steps.length ? { ...base, ...steps[i++] } : { ...base };
    },
  };
}

// Usage:
const adapter = scriptedAdapter([
  { message: { role: 'assistant', content: '' }, toolCalls: [{ name: 'peek', arguments: { chars: 500 } }] },
  { message: { role: 'assistant', content: '' }, toolCalls: [{ name: 'final_answer', arguments: { content: 'The answer is 42.' } }] },
]);
```

### Detecting synthesis calls

Some orchestrators (like `RLMRunner`) call `invoke` without tools when they want a plain-text synthesis response. Detect this in a stub to return the right thing:

```ts
import type { InferenceAdapter, InferenceResponse, BaseCompleteOptions, Message } from '@tkottke90/inference-adapter';

const smartStub: InferenceAdapter = {
  async invoke(
    _messages: Message[],
    options?: BaseCompleteOptions,
  ): Promise<InferenceResponse> {
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

### Stub embedding adapter

```ts
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';

const stubEmbedder: EmbeddingAdapter = {
  model: 'stub-model',
  async embed(texts: string[]): Promise<number[][]> {
    // Return zero vectors of dimension 4 — enough to satisfy the interface
    return texts.map(() => [0, 0, 0, 0]);
  },
};
```
