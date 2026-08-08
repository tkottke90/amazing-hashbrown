## Observability Configuration

amazing-hashbrown records detailed traces of every LLM call, tool invocation, token count, and response latency in the SQLite database. This gives you a full audit trail of what the agent did and how much it cost.

### Enabling and Disabling

Observability is controlled by the `observability.enabled` setting:

```yaml
observability:
  enabled: true
```

Set to `false` to stop recording traces entirely. Disabling observability has no effect on chat functionality — the agent still works normally, you just lose the recorded history.

### Controlling Storage Size

The most impactful setting for database size is `spanOutputPreviewChars`:

```yaml
observability:
  enabled: true
  spanOutputPreviewChars: 500
```

This controls how many characters of each LLM response or tool result are stored per span (trace entry). The three practical values are:

| Value | Behavior |
|---|---|
| `500` (default) | Stores a preview of each output — good balance of detail and storage |
| `-1` | Stores the full content of every LLM call and tool result — useful for deep debugging |
| `0` | Stores token counts and latency only, no content — smallest possible footprint |

If you are debugging unexpected agent behavior or want to replay exactly what the model produced, set this to `-1` temporarily. Switch back to `500` or `0` for normal operation.

### AfterAgent Traces

Background AfterAgent runs are included in the trace store alongside foreground chat turns. They are distinguished by span names prefixed with `after-agent:`, so you can filter them separately when browsing traces.

This means if you want to audit what the AfterAgent extracted and wrote to the wiki after a conversation, the full reasoning trace is available in the observability view.

### Cost Data

Token counts recorded in spans are also used to compute cost data. See [[Cost Tracking]] and [[Cost Rates Configuration]] for how to set up dollar-amount tracking on top of raw token counts.
