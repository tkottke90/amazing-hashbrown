---
title: Why Isn't the Agent Saving Anything to the Wiki?
---

## Why Isn't the Agent Saving Anything to the Wiki?

If the AfterAgent indicator shows "Nothing new to save" every turn, work through the checklist below.

### 1. AfterAgent Is Disabled

Check `config.yaml`:

```yaml
afterAgent:
  enabled: false # <-- this is the problem
```

Set `enabled: true` and restart the server. If the key is missing entirely, AfterAgent defaults to enabled — the issue is elsewhere.

### 2. The Conversations Are Not Novel

The [[AfterAgent and the Knowledge Base|AfterAgent pipeline]] classifies each turn before writing. It skips:

- Topics already fully covered in the wiki
- Purely procedural exchanges (e.g. "format this text", "rewrite this sentence")
- Small talk and greetings
- Conversations that produce no new factual claims

This is by design. If your conversations are genuinely producing new information that you expect to be saved, check cause 3 before assuming this is the explanation.

### 3. No Domains Are Registered

AfterAgent needs at least one active domain to write to. Open the wiki view at `/wiki` and confirm that at least one domain appears in the domain filter. If the list is empty, create a domain first — see [[How to Create a New Wiki Domain]].

### 4. The Only Available Domain Is Read-Only

Some domains (such as the built-in `app-docs` domain) are read-only and cannot be written to by AfterAgent. Check that your `user` domain exists and is shown as active in the wiki view. If it is missing, re-create it via the agent.

### 5. Model Quality

Weaker models may fail to correctly classify or extract content during the AfterAgent pipeline steps. If you are using a smaller or less capable model, try switching to a more capable one and see whether saves start occurring.

See [[AfterAgent Configuration]] for model settings.

### Checking What AfterAgent Decided

If you want to see AfterAgent's reasoning for a specific turn, ask the agent:

> "Why didn't you save anything from our last conversation to the wiki?"

The agent can inspect the pipeline log and explain which step caused the skip.

### Related Pages

- [[AfterAgent and the Knowledge Base]]
- [[AfterAgent Configuration]]
- [[How to Create a New Wiki Domain]]
- [[Wiki Domains]]
