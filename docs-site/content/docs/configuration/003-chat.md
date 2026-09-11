---
title: Chat
section: Configuration
order: 4
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Chat

Controls conversation-level behavior: how much history stays in context, when a long-running thread gets summarized, and what a failed turn looks like afterward.

| Key                  | Type    | Default | Description                                                                                                                                                                       |
| --------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showErrorMessages`   | boolean | `false` | When `false`, a failed turn that's since been retried is hidden from history — only the successful retry shows. A turn that hasn't been retried yet is always shown regardless.  |
| `contextWindow`       | object  | —       | Sliding-window trimming that keeps a conversation under a token budget. See below.                                                                                                |
| `conversationSearch`  | object  | —       | The `search_conversation` tool, letting the agent recall messages that have scrolled out of the active window. See below.                                                        |
| `workspaceSummary`    | object  | —       | Periodic summarization of a workspace's chat thread, so long project conversations don't grow unbounded. See below.                                                              |

{% call code(language="yaml") %}
chat:
  showErrorMessages: false
  contextWindow:
    enabled: true
    maxTokens: 32000
  conversationSearch:
    enabled: true
    threshold: 20
  workspaceSummary:
    enabled: true
    messageThreshold: 40
{% endcall %}

`showErrorMessages` is also overridable per request via `GET /api/v1/threads/:id?showErrors=true`.

### `contextWindow`

Older messages are dropped — oldest first — once a turn would exceed `maxTokens`, while always preserving the system prompt and making sure the kept history starts on a human turn rather than mid-tool-call. Tokens are estimated at 4 characters each, which is accurate enough for budgeting without a model-based counter.

Rough starting points by model family (leave headroom for the reply itself):

| Model family                           | Suggested `maxTokens` |
| --------------------------------------- | ---------------------- |
| Small local models (GLM-4-Flash, etc.)  | 16,000 – 24,000        |
| Llama 3 8B / 13B                        | 24,000 – 32,000        |
| GPT-4.1-mini / Claude Haiku              | 64,000 – 96,000        |

### `conversationSearch`

Registers a tool the agent can call to search further back in a thread than the active context window reaches. `threshold` is the minimum number of messages a thread needs before the tool is registered at all — below it, the whole history already fits in context, so the tool has nothing to add.

### `workspaceSummary`

For workspace chat threads specifically: once `messageThreshold` messages have passed since the last summary, the next turn automatically triggers a fresh one. The "Summarize" button in the Chat tab bypasses the threshold and always runs on demand.

### Switching model mid-thread

The chat input's "+" menu has a "Provider" item — hovering (or, on mobile, tapping) it drills into the configured providers, and hovering a provider drills into that provider's available models. Selecting a model switches the active thread to it immediately; per-model pricing shows alongside models that have `inputPricePerM`/`outputPricePerM` configured.

<figure class="flex flex-col items-center text-center">
  <img src="{{ '/assets/model-picker-dropdown.png' | url }}" alt="The chat input's model picker drilled down to the local provider, listing its available models with the active model checked">
  <figcaption>Example: switching models from the chat input</figcaption>
</figure>
