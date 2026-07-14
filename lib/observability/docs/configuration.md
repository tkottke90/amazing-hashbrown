# Configuration

Observability is configured under the `observability:` key in `config.yaml`.
The database path lives in the separate `database:` section because all
application features share the same file.

```yaml
database:
  path: app.db

observability:
  enabled: true
  spanOutputPreviewChars: 500
```

---

## `database.path`

**Type**: string  
**Default**: `app.db`

Path to the shared SQLite database file. All application features (observability,
task system, persistent memory) share this file — do not delete it between
restarts or you will lose all stored traces, spans, and related data.

Relative paths are resolved from the directory that contains `config.yaml`,
so the default `app.db` places the database alongside the config file. Use an
absolute path for production deployments.

```yaml
# Production example
database:
  path: /var/data/myapp/app.db
```

---

## `observability.enabled`

**Type**: boolean  
**Default**: `true`

When `false`, the API skips starting traces and no data is written to the database. The database file is not created or modified. Existing traces remain readable.

---

## `observability.spanOutputPreviewChars`

**Type**: number  
**Default**: `500`

Controls how much text content is saved per span. This affects `outputPreview` for all spans and `inputPreview` for `llm-call` spans. It does NOT affect tool call arguments (`inputPreview` on `tool-call` spans), which are always stored in full.

| Value           | Behavior                                                               |
| --------------- | ---------------------------------------------------------------------- |
| `500` (default) | First 500 characters of the model response or tool result              |
| `-1`            | Full text stored (highest fidelity; can grow large for long responses) |
| `0`             | No text stored — only token counts, latency, and timing are recorded   |

**When to change this:**

- Use `-1` during active development or debugging to see complete model responses and tool results.
- Use `0` if you only need cost and latency data and want to minimize disk usage.
- Leave at `500` (the default) for normal operation. It gives enough context to debug most issues without storing large amounts of text.
