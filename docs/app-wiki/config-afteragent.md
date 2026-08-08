## AfterAgent Configuration

The AfterAgent is a background pipeline that runs automatically after each chat turn. Its job is to read what was just discussed and write useful knowledge into the wiki so it accumulates over time.

### Enabling and Disabling

The AfterAgent is controlled by the `afterAgent.enabled` setting in `config.yaml`:

```yaml
afterAgent:
  enabled: true
```

Set it to `false` to disable the pipeline entirely:

```yaml
afterAgent:
  enabled: false
```

When disabled:

- The agent continues to chat normally — responses are unaffected.
- Nothing is written to the wiki automatically after conversations.
- The background spinner in the chat UI is hidden (since no background work is happening).

This is a **process-level switch** — it applies to all threads and all users of the instance. There is no per-thread toggle.

### When to Disable AfterAgent

You might disable AfterAgent if:

- You are experimenting and do not want test conversations polluting your wiki.
- You are using a very slow or expensive model and want to reduce background inference costs.
- You want full manual control over what gets written to the wiki.

### Changing the Setting Without a Restart

Like most config settings, `afterAgent.enabled` can be toggled via the **Settings UI** without restarting the container. The pipeline picks up the new value on the next chat turn.

### Relationship to the Wiki

With AfterAgent enabled, the wiki grows and improves automatically. With it disabled, the wiki only changes when the agent explicitly writes to it during a foreground chat turn (for example, if you ask it to "save this to the wiki"). Either way, you retain full manual control over wiki pages through the wiki browser in the UI.

See [[AfterAgent Pipeline]] for a detailed explanation of how the pipeline works and what it extracts.
