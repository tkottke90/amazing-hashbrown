# Retrieval Loop Model (RLM)

The **Retrieval Loop Model (RLM)** is a technique the agent uses when it needs to answer a question from a text source that's too large to fit in the model's context window. Rather than loading the entire document, the agent iterates through a set of focused retrieval operations — peeking at structure, searching for keywords, slicing out specific sections — until it has gathered enough targeted fragments to answer.

## How It Works

You don't invoke RLM directly. It activates automatically via the `rlm_query` tool when:

- A wiki page is fetched and its content exceeds the `rlm.truncateThreshold` character limit
- The agent is given a large external document to query

Once active, the agent uses a focused set of retrieval tools:

- **Table of contents scan** — get an overview of the document's structure
- **Keyword grep** — locate specific terms or phrases
- **Section slice** — extract a defined range of content by heading or line number

The loop continues until one of three things happens:

1. The model calls `final_answer` — the agent has enough information
2. The model calls `not_found` — the information isn't in the document
3. The loop hits `rlm.maxIterations` (default: **10**) — the search is abandoned with whatever was found

## Separate Model for RLM

You can configure a different model specifically for RLM queries via `rlm.provider` and `rlm.model`. This is useful for keeping costs down: use a fast, inexpensive model for the retrieval loop and reserve your main (more capable) model for the actual chat response.

```yaml
rlm:
  provider: anthropic
  model: claude-haiku-4-5
  maxIterations: 10
  truncateThreshold: 20000
```

See [[Config RLM]] for the full reference. For information on how wiki pages are stored and truncated, see [[How the Wiki Works]].
