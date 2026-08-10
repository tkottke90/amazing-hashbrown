## What Is amazing-hashbrown

amazing-hashbrown is a self-hosted AI agent harness built around a persistent, domain-organized knowledge base — a wiki that grows smarter with every conversation.

### The Core Idea

Most AI chat tools treat each conversation as a clean slate. amazing-hashbrown is different: after every chat turn, a background pipeline called the [[AfterAgent Pipeline]] reads what was discussed and writes useful knowledge back into a structured wiki. The next time you ask a related question, the agent already knows the answer — not because it memorized it, but because it filed it away.

This makes the system compound over time. The more you use it, the more it knows about your specific domain, projects, and preferences.

### How It Works

You interact with a browser-based chat UI. Behind the scenes:

- A **ReAct AI agent** receives your message and decides which tools to use.
- The agent has **17 built-in tools** — wiki reads and writes, web fetching, shell execution, and more.
- When the agent finishes responding, the **AfterAgent pipeline** automatically extracts knowledge and updates the wiki.

### Key Features

- **Multi-domain wiki** — organize knowledge into separate domains so different projects or topics stay clean.
- **Any LLM, locally or in the cloud** — run inference through Ollama (fully local, no internet required), OpenAI, or Anthropic. See [[How to Set Up Ollama]] and [[How to Add a Provider]].
- **MCP tool support** — connect external tools via the Model Context Protocol.
- **Skills and slash commands** — define reusable agent behaviors as skill files.
- **Shell tool with approval flow** — the agent can run shell commands, but each command is shown to you for approval before execution.
- **Settings UI** — configure providers, models, and all behavior from the browser; no YAML editing required unless you prefer it.
- **Full observability** — every LLM call, token count, and tool invocation is recorded. See [[Observability Configuration]] and [[Cost Tracking]].

### What It Is Not

amazing-hashbrown is not a standard RAG (retrieval-augmented generation) system. In a typical RAG setup, documents are indexed but never updated by the AI. Here the agent actively maintains the wiki — adding, revising, and reorganizing entries as it learns. Knowledge accumulates rather than decays.

### Getting Started

- To deploy: [[How to Deploy with Docker]]
- To add an LLM: [[How to Add a Provider]]
- To understand configuration: [[config.yaml Overview]]
