---
title: Overview
section: Configuration
order: 1
layout: doc.njk
permalink: /docs/configuration/
---

{% from "macros/code.njk" import code %}

## Overview

Amazing Hashbrown is configured through **one YAML file** — `config/config.yaml` — plus a handful of environment variables for secrets and bootstrap options. Every provider you connect, every storage path, and every knob on the agent's behavior lives in that one file, and it's generated with working defaults the first time you start the app, so you don't have to write it from scratch.

### Where it lives

- Resolved from the `CONFIG_DIR` environment variable, falling back to `./config` next to wherever the API process starts.
- If `config/config.yaml` doesn't exist yet, it's **created automatically** from the schema's defaults on first run.
- When you upgrade and a future release adds a new option, it's filled in with its default and **written back** into your existing file — you never have to hand-merge new settings in.
- YAML or JSON both work; the file extension decides which parser runs.

### Two ways to change it

1. **Edit the file directly.** Open `config/config.yaml` in any editor, change a value, restart the API. This is the only option for a few low-level settings — storage paths, the shell tool's allow/deny lists — that only apply at boot.
2. **Use the Settings UI.** Most day-to-day settings — providers, embeddings, cost rates, agent behavior, tools, workspaces — have a matching panel in the app's Settings screen, so you can change them from the browser without touching a file or restarting.

Both read and write the same file, so they never drift out of sync with each other.

### Keeping secrets out of the file

Any string value in `config.yaml` can reference an environment variable with `${UPPER_CASE}` syntax:

{% call code(language="yaml") %}
providers:
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
{% endcall %}

`${OPENAI_API_KEY}` is swapped for `process.env.OPENAI_API_KEY` when the file loads. The API also reads a `.env` file from its working directory at startup, so `OPENAI_API_KEY=sk-...` in a local `.env` works the same as exporting it in your shell — this is the recommended way to keep API keys out of a file you might otherwise be tempted to commit.

### The one thing every install needs: providers

Everything else has a working default. The one section worth looking at on day one is `providers` — the list of LLM backends the agent can call — plus `defaultProvider`, which one it uses when a request doesn't ask for a specific one.

{% call code(language="yaml") %}
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3

defaultProvider: local
{% endcall %}

You can list more than one — a local Ollama model alongside OpenAI or Anthropic, for example — and switch between them per conversation from the model picker in the UI.

### What else you can configure

The rest of the file groups roughly by feature. You won't need to touch most of it right away — each one has its own page with the full option list and examples:

- [AfterAgent](/docs/configuration/001-afteragent/) — the background pass that decides what a conversation is worth writing back into the wiki.
- [Agent](/docs/configuration/002-agent/) — recursion limits for the reasoning loop, so a runaway chain of tool calls fails safely instead of running forever.
- [Chat](/docs/configuration/003-chat/) — context-window trimming, when a long-running conversation gets auto-summarized, and whether failed turns stay visible in history.
- [Embeddings](/docs/configuration/004-embeddings/) — the model used for semantic wiki search; search falls back to keyword-only matching if this is disabled or unreachable.
- [Observability & Costs](/docs/configuration/005-observability-and-costs/) — how much detail is recorded per turn, and per-model token pricing used to estimate spend.
- [RLM](/docs/configuration/006-rlm/) — how the agent works through a long document iteratively instead of dumping it whole into context.
- [Shell Tool](/docs/configuration/007-shell-tool/) — the allow/deny lists and environment the shell-execution tool runs with.
- [Storage Paths](/docs/configuration/008-storage-paths/) — `wikiRoot`, `artifactRoot`, `skillsRoot`, `projectsRoot`: where the wiki, uploaded files, skills, and workspace projects live on disk.
- [Workspace Trackers](/docs/configuration/009-workspace-trackers/) — connecting a workspace to an external issue tracker like GitHub, so the agent can pick up and link real tickets.

### Where to go next

- [Quick Start](/docs/quick-start/) — get the app running on its defaults before tuning anything.
- [Workspaces](/docs/workspaces/) — where `projectsRoot` and tracker configuration come into play.
- [LLM Wiki](/docs/llm-wiki/) — the knowledge base that `wikiRoot` points at.
