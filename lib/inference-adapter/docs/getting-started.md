# Getting started with `@tkottke90/inference-adapter`

This guide explains the core concepts and walks through your first AI inference call. No prior experience with AI models or LLMs is assumed.

---

## What is "inference"?

**Inference** is the act of asking an AI language model a question and getting an answer. When you use a chat app or ask ChatGPT something, "inference" is what happens under the hood — the model processes your input and produces a response.

This package provides a standard way to make those calls from TypeScript, regardless of which AI backend you're using.

---

## Key concepts

### Messages

AI models don't work with single questions — they work with **conversations**. A conversation is a list of messages, and each message has a **role** that identifies who said it:

| Role | Who | What it contains |
|---|---|---|
| `'system'` | You (the developer) | Background instructions that shape how the model behaves: "You are a helpful assistant. Answer concisely." |
| `'user'` | The person using your app | The question or request being asked. |
| `'assistant'` | The AI model | The model's reply. |
| `'tool'` | Your code | The result of a function the model asked your code to run (more on this below). |

A minimal conversation is just a single `user` message. Most real conversations also include a `system` message at the start, which you as the developer write to set the model's context and behavior.

```ts
import type { Message } from '@tkottke90/inference-adapter';

const messages: Message[] = [
  { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
  { role: 'user', content: 'What year was TypeScript first released?' },
];
```

### Inference response

When you call `adapter.invoke(messages)`, you get back an `InferenceResponse`. The model's reply is always in `response.message`:

```ts
const response = await adapter.invoke(messages);

console.log(response.message.role);    // 'assistant'
console.log(response.message.content); // "TypeScript was first released in October 2012."
```

The `response.message` is always an assistant message. Its `content` is a plain text string — the model's reply.

### Tools (optional)

**Tools** are functions that you define and that the model can choose to call during a conversation. You describe what each tool does and what parameters it needs; the model decides whether and when to call one; your code actually runs it and sends back the result.

Tools are useful when the model needs real-time information (current weather, a database lookup) or needs to take an action (send an email, run a calculation).

See the [Tool calling walkthrough](#tool-calling-walkthrough) section below for the full step-by-step.

### Embeddings (optional)

**Embeddings** convert text into a list of floating-point numbers (a "vector") that encodes the meaning of the text. Two sentences with similar meanings will produce similar vectors, even if they use completely different words.

This is useful for **semantic search**: instead of searching for an exact keyword match, you can find passages that mean the same thing as your query. Embeddings require a separate interface — `EmbeddingAdapter` — which is described in the [Embeddings](#embeddings) section below.

---

## Prerequisites

You need [Ollama](https://ollama.com) running locally with at least one model pulled:

```sh
# Install Ollama — see https://ollama.com for your platform
ollama serve           # start the server (runs on http://localhost:11434 by default)
ollama pull qwen3:8b   # recommended model; ~5 GB download
```

And **Node.js 18 or later** with this monorepo cloned.

```sh
# From the repo root — installs all workspace dependencies
npm install

# Build the package
npm run build --workspace lib/inference-adapter
```

---

## Your first inference call

```ts
import { OllamaInferenceAdapter } from '@tkottke90/inference-adapter';
import type { Message } from '@tkottke90/inference-adapter';

// Create the adapter — tells it which server and model to use
const adapter = new OllamaInferenceAdapter({
  model: 'qwen3:8b',
  baseUrl: 'http://localhost:11434',
});

// Build the conversation
const messages: Message[] = [
  { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
  { role: 'user', content: 'What is 12 × 7?' },
];

// Call the model and wait for its response
const response = await adapter.invoke(messages);

// The model's reply is in response.message.content
console.log(response.message.content); // "84"
```

`invoke` sends the complete conversation history to the model and returns the model's reply. The model has no memory between separate `invoke` calls — you are always responsible for passing the full history.

---

## Multi-turn conversations

To keep a conversation going, add the model's reply and the next user message to the history array, then call `invoke` again:

```ts
import { OllamaInferenceAdapter } from '@tkottke90/inference-adapter';
import type { Message } from '@tkottke90/inference-adapter';

const adapter = new OllamaInferenceAdapter({ model: 'qwen3:8b' });

const history: Message[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'My name is Alex.' },
];

const r1 = await adapter.invoke(history);
console.log(r1.message.content); // "Nice to meet you, Alex!"

// Append the assistant's reply and the next question
history.push(r1.message);
history.push({ role: 'user', content: "What's my name?" });

const r2 = await adapter.invoke(history);
console.log(r2.message.content); // "Your name is Alex."
```

The model "remembers" information from earlier in the conversation only because you kept passing it in the `history` array. Without that, each call starts fresh.

---

## Tool calling walkthrough

Tools let the model ask your code to run a function when it needs real information or needs to take an action. Here is the complete loop, step by step.

### Step 1 — Define the tool

Use [Zod](https://zod.dev) to describe the tool's parameters. The `description` fields tell the model what the tool does and when to use it.

```ts
import { z } from 'zod';
import type { ToolDefinition } from '@tkottke90/inference-adapter';

const getStockPrice: ToolDefinition = {
  name: 'get_stock_price',
  description: 'Look up the current stock price for a ticker symbol.',
  parameters: z.object({
    ticker: z.string().describe('Stock ticker symbol, e.g. AAPL'),
  }),
};
```

### Step 2 — Pass the tool to `invoke`

```ts
const messages: Message[] = [
  { role: 'user', content: "What is Apple's stock price?" },
];

const response = await adapter.invoke(messages, {
  tools: [getStockPrice],
});
```

### Step 3 — Check whether the model called a tool

```ts
if (response.toolCalls && response.toolCalls.length > 0) {
  const call = response.toolCalls[0]!;
  console.log(call.name);       // 'get_stock_price'
  console.log(call.arguments);  // { ticker: 'AAPL' }
```

### Step 4 — Run the function and send the result back

```ts
  // Run your real function
  const price = await fetchStockPrice(call.arguments.ticker as string);

  // Add the assistant's tool-call turn to history
  messages.push({
    role: 'assistant',
    content: response.message.content,
    toolCalls: response.toolCalls,
  });

  // Add the tool result turn
  messages.push({
    role: 'tool',
    results: [{ id: call.id, content: `Current price: $${price}` }],
  });

  // Call the model again — it will compose a final answer using the tool result
  const final = await adapter.invoke(messages, { tools: [getStockPrice] });
  console.log(final.message.content); // "Apple's current stock price is $213.48."
}
```

**Important rule:** after a tool call turn, always push *both* the `assistant` message (which includes `toolCalls`) *and* the `tool` message (which includes `results`) before calling `invoke` again.

---

## Structured output

When you want the model to return a structured object instead of free-form text, pass a Zod schema in `options.schema`:

```ts
import { z } from 'zod';

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
  city: z.string(),
});

const response = await adapter.invoke(
  [{ role: 'user', content: 'Extract: "Alice is 30 and lives in Seattle."' }],
  { schema: PersonSchema },
);

// The parsed object lands in response.structured
const person = response.structured as z.infer<typeof PersonSchema>;
console.log(person.name); // "Alice"
console.log(person.city); // "Seattle"
```

The adapter validates the model's output against the schema and retries on mismatch. The raw JSON string is also available in `response.message.content`.

---

## Embeddings

Embeddings require an `EmbeddingAdapter`. This package defines the `EmbeddingAdapter` interface but does not ship a concrete implementation — embedding adapters live in sibling packages:

- **`@tkottke90/rlm/adapters`** — provides `OllamaEmbeddingAdapter` for Ollama's `/api/embed` endpoint
- **`@tkottke90/llm-wiki/providers`** — provides `OllamaEmbeddingProvider`, `OpenAIEmbeddingProvider`, `AnthropicEmbeddingProvider`, and `NullEmbeddingProvider`

The `EmbeddingAdapter` contract is simple: call `embed()` with a batch of strings, get back a parallel array of number vectors:

```ts
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';

// adapter: any class implementing EmbeddingAdapter
const vectors: number[][] = await adapter.embed([
  'The cat sat on the mat.',
  'A feline rested on the rug.',
]);

// Both vectors encode similar meanings and will be close in vector space
console.log(vectors.length);    // 2
console.log(vectors[0].length); // e.g. 768 (depends on the model)
```

See the docs for the package that provides the implementation you want for setup instructions.

---

## Using `NullInferenceAdapter` in tests

When writing tests, avoid calling a real LLM. `NullInferenceAdapter` always returns an empty assistant message instantly — no network, no latency:

```ts
import { NullInferenceAdapter } from '@tkottke90/inference-adapter';

const adapter = new NullInferenceAdapter();
const response = await adapter.invoke([{ role: 'user', content: 'anything' }]);

console.log(response.message.content); // ''
console.log(response.toolCalls);       // undefined
```

For tests that need scripted responses (different replies for different calls), see [docs/custom-adapters.md](./custom-adapters.md#testing-with-stub-adapters).

---

## Controlling generation (sampling parameters)

Pass optional parameters to `invoke` to control how the model generates text:

```ts
const response = await adapter.invoke(messages, {
  temperature: 0.2, // lower = more focused; higher = more creative (0.0–2.0)
  topP: 0.9,        // nucleus sampling probability threshold
  maxTokens: 500,   // stop generating after this many tokens
});
```

See [docs/api-reference.md](./api-reference.md#basesamplingparams) for the full parameter list and what each one does.

---

## Next steps

- **[api-reference.md](./api-reference.md)** — complete reference for every exported type, interface, and class
- **[custom-adapters.md](./custom-adapters.md)** — write an adapter for Anthropic, OpenAI, a local HTTP server, or any other LLM backend
