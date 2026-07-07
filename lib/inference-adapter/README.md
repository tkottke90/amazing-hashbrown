# `@tkottke90/inference-adapter`

Shared type vocabulary and pluggable connectors for AI language model backends. Lets sibling packages work with any LLM without hard-coding a specific API.

## What this is

Think of it as a **power-strip adapter** — your code (the device) doesn't change; only the plug (the adapter) changes based on which AI backend you're targeting. This package defines a single interface, `InferenceAdapter`, and provides a concrete implementation for [Ollama](https://ollama.com). Other packages in this monorepo depend on the interface, not on any specific backend, so swapping models requires no changes to application logic.

## What it does

- Defines the **shared type vocabulary** used across this monorepo: `Message`, `ToolCall`, `ToolDefinition`, `InferenceResponse`, `EmbeddingAdapter`, and more.
- Provides **`OllamaInferenceAdapter`** — a ready-to-use connector for the Ollama local inference server.
- Provides **`NullInferenceAdapter`** — a no-op stub for tests and CI.

## What it does NOT do

- **No prompt engineering.** Building prompts is the consuming package's job.
- **No streaming.** All calls are single-turn request/response.
- **Only Ollama is implemented.** The `InferenceAdapter` interface is the extension point — see [docs/custom-adapters.md](./docs/custom-adapters.md) to connect other backends.

---

## Quick start

```ts
import { OllamaInferenceAdapter } from '@tkottke90/inference-adapter';

const adapter = new OllamaInferenceAdapter({
  model: 'qwen3:8b',
  baseUrl: 'http://localhost:11434',
});

const response = await adapter.invoke([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France?' },
]);

console.log(response.message.content); // "The capital of France is Paris."
```

---

## Documentation

| File                                                 | Contents                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| [docs/getting-started.md](./docs/getting-started.md) | Key concepts, first inference call, tool calling walkthrough, embeddings  |
| [docs/api-reference.md](./docs/api-reference.md)     | Complete reference for all exported types, interfaces, and classes        |
| [docs/custom-adapters.md](./docs/custom-adapters.md) | Writing a custom `InferenceAdapter` or `EmbeddingAdapter` for any backend |

---

## Running tests

The package does not yet have a test suite. Dev dependencies (mocha, chai, tsx) are scaffolded and ready when tests are added.
