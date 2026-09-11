---
title: AfterAgent
section: Configuration
order: 2
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## AfterAgent

The background pass that looks at a finished conversation turn and decides whether anything in it is worth writing back into the wiki. It runs after the turn's response has already streamed to the user, so it never adds latency to the reply itself.

| Key       | Type    | Default | Description                          |
| --------- | ------- | ------- | ------------------------------------ |
| `enabled` | boolean | `true`  | Global kill switch for the pipeline. |

{% call code(language="yaml") %}
afterAgent:
  enabled: true
{% endcall %}

This is a global switch — it can also be turned off per request via the `afterAgent` field on `POST /api/v1/chat/:threadId`, but the setting here always wins if it's `false`.
