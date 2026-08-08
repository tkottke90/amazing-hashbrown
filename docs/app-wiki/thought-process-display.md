# Thought Process Display

Some models emit **reasoning tokens** — a stream of the model's internal deliberation before it commits to a final response. amazing-hashbrown captures these tokens and renders them as a collapsible **"Thought process"** block (marked with a brain icon) above the assistant's reply.

## Models That Support This

Reasoning tokens are emitted by:

- **Anthropic's Claude** models when **extended thinking** is enabled
- Certain **Ollama** models that expose a thinking/reasoning stream

If you don't see a thought process block, your current model either doesn't support extended thinking or has it disabled. Check the model's settings for a reasoning or thinking toggle. See [[How to Switch Models in a Conversation]].

## What You See While the Model Is Thinking

While the model is still generating its reasoning, the block shows **"Thinking…"** with an animated indicator. The final response area remains empty during this phase.

Once the model transitions from reasoning to its final answer:
1. The thought process block collapses automatically
2. The final response begins streaming in below it

You can expand the thought process block at any time — during streaming or after — to read the full reasoning chain.

## What's in the Thought Process

The content varies by model, but typically includes:

- **Problem decomposition** — breaking the question into parts
- **Tool planning** — deciding which tools to call and in what order
- **Uncertainty flagging** — noting where the model isn't sure and how it's resolving it
- **Self-correction** — catching and revising earlier conclusions mid-thought

The thought process is read-only — you can't edit or steer it. It's purely for visibility into how the model arrived at its answer.

## Collapsed by Default

The block is collapsed after streaming completes to keep the interface clean. The response is what you act on; the thought process is there when you want to audit it or understand a surprising conclusion.
