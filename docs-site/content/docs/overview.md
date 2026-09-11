---
title: Overview
section: Overview
order: 1
layout: doc.njk
---

## Overview

Amazing Hashbrown is a **self-hosted AI agent harness** — the application that sits around an LLM and gives it a chat interface, memory, a place to do work, and a set of tools, all running on infrastructure you control instead of inside someone else's product.

If you've used Claude or ChatGPT, you already know what a capable model can do in a single conversation. What you may not have run yourself is the _harness_ around it: the part that decides what the model can see, what tools it can reach for, where anything it learns actually goes when the chat window closes, and where it runs. Amazing Hashbrown is that harness — open source, and designed to run entirely on your own machine.

### Why run your own harness?

Two things motivate the project:

**Ownership.** A hosted chat product forgets everything between sessions and keeps your data on someone else's servers. Running the harness yourself means the conversation history, the knowledge the agent accumulates, and the projects it works on all live on disk, under your control.

**Context is scarce.** Local models generally have far smaller context windows than frontier models, and Amazing Hashbrown was built with that constraint in mind — hence the "local-first" framing, though it works with hosted providers like OpenAI and Anthropic too, once configured. Many agent harnesses cope with limited context by stuffing everything the model might need — documentation, prior conversation, every available tool — into the system prompt on every single turn. That leaves little room for the model to actually think, and it wastes context on models that could have handled a bigger prompt just as well. Amazing Hashbrown's design pulls information in only when it's needed:

- Knowledge is **searched and read on demand** from an on-disk knowledge base, rather than pre-loaded.
- Long documents are read **iteratively**, a piece at a time, instead of dumped in whole.
- Less-common tools stay **hidden until the matching capability is invoked**, instead of sitting in the tool list on every turn.

The result is a harness that scales down to small local models without falling over, and scales up to frontier models without wasting their context either.

### The core pieces

**Chat agent.** The part you talk to. It's a [ReAct-style](https://arxiv.org/abs/2210.03629) agent — it reasons about your message, decides whether it needs a tool, calls it, and folds the result back into its thinking, the same tool-calling loop you'd see in any modern LLM product. The difference is that here you can see and configure every part of that loop: which model answers, which tools are on the table, and what happens after the response is sent.

**LLM Wiki.** The agent's long-term memory. Instead of a vector database it silently searches, knowledge lives in a plain, human-readable set of markdown pages organized into domains — a wiki the agent can search, read, and, after a conversation ends, write back to. You can open those files yourself, in any editor, and see exactly what the agent has learned. The pattern comes from Andrej Karpathy's LLM Wiki concept; see [LLM Wiki](/docs/llm-wiki/) for the full idea and a link to the original source.

**Workspaces.** A bounded place for the agent to do real, sustained work rather than just answer questions — a project directory, its own wiki domain, and optionally a link to an issue tracker, so the agent can pick up a task, work it over multiple turns, and hand back real changes instead of just advice. See [Workspaces](/docs/workspaces/).

**Skills.** Slash-command-gated capabilities — store a step-by-step process in a markdown file, then provide that when you need the agent to follow that process. Capture _mechanical work_ as scripts the agent will call from the command line, and provide _cognitive work_ as a set of instructions the agent will follow in its reasoning. See [Skills](/docs/skills/) for more.

**Observability.** Every LLM call, token count, and tool invocation is recorded locally, so you can see exactly what the agent did and why — useful both for debugging a misbehaving local model and for building trust in a system you're running yourself.

### Where to go next

- [Quick Start](/docs/getting-started/) — install the app and have a working chat agent running locally.
- [LLM Wiki](/docs/llm-wiki/) — the knowledge base pattern behind the agent's memory.
- [Configuration](/docs/configuration/) — providers, models, and the rest of `config.yaml`.
