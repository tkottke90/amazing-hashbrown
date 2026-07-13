# Configuration

Observability is configured under the `observability:` key in `config.yaml`.

```yaml
observability:
  enabled: true
  dbPath: ./config/app.db
  spanOutputPreviewChars: 500
```

---

## `enabled`

**Type**: boolean  
**Default**: `true`

When `false`, the API skips starting traces and no data is written to the database. The database file is not created or modified. Existing traces remain readable.

---

## `dbPath`

**Type**: string  
**Default**: `./config/app.db`

Path to the shared SQLite database file. All application features share this file — do not delete it between restarts or you will lose all stored traces, spans, and (in the future) task records and memory entries.

The path is resolved relative to the process working directory. For production deployments, use an absolute path.

```yaml
# Production example
dbPath: /var/data/myapp/app.db
```

---

## `spanOutputPreviewChars`

**Type**: number  
**Default**: `500`

Controls how much text content is saved per span. This affects `outputPreview` for all spans and `inputPreview` for `llm-call` spans. It does NOT affect tool call arguments (`inputPreview` on `tool-call` spans), which are always stored in full.

| Value | Behavior |
|-------|----------|
| `500` (default) | First 500 characters of the model response or tool result |
| `-1` | Full text stored (highest fidelity; can grow large for long responses) |
| `0` | No text stored — only token counts, latency, and timing are recorded |

**When to change this:**

- Use `-1` during active development or debugging to see complete model responses and tool results.
- Use `0` if you only need cost and latency data and want to minimize disk usage.
- Leave at `500` (the default) for normal operation. It gives enough context to debug most issues without storing large amounts of text.
