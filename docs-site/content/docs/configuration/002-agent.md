---
title: Agent
section: Configuration
order: 3
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Agent

Controls how far the agent's reasoning loop is allowed to run before it's stopped as a safety measure, across both the chat agent and the wiki-ingestion agent.

| Key                      | Type   | Default | Description                                                                                                                         |
| ------------------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `recursionLimit`         | number | `100`   | Maximum number of steps per agent invocation. Every tool call counts as a step, not just model turns.                                |
| `recursionWarnThreshold` | number | `0.75`  | Fraction of `recursionLimit` at which the agent is interrupted and asked to wrap up, before it's forcibly stopped at the hard limit. |

{% call code(language="yaml") %}
agent:
  recursionLimit: 100
  recursionWarnThreshold: 0.75
{% endcall %}

At the defaults, a runaway chain of tool calls gets interrupted around step 75 of 100 — a warning with room to recover, rather than a hard stop with no explanation.
