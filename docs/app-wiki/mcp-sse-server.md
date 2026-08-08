## MCP SSE Server

An SSE MCP server is an already-running HTTP service that amazing-hashbrown connects to using Server-Sent Events. Unlike stdio servers, the app does not start or stop the server — it must be running and reachable before the connection is attempted.

### Configuration

SSE servers are configured in `mcp.json` under the `mcpServers` key:

```json
{
  "mcpServers": {
    "my-remote-tool": {
      "transport": "sse",
      "url": "http://192.168.1.50:3001/sse"
    }
  }
}
```

### Fields

- **`transport`** — must be `"sse"` to select the SSE transport.
- **`url`** — the full URL of the SSE endpoint on the MCP server. This must point to the `/sse` path (or whatever path the server exposes for its SSE stream).

### Before You Connect

The remote server must be **running and reachable** before amazing-hashbrown starts (or before the MCP config is reloaded). If the server is down at startup, the connection attempt will fail and the server's tools will not be available until the config is reloaded with the server running.

### When to Use SSE Servers

SSE servers are the right choice when:

- The server is **shared across a team** — multiple users connect to the same instance
- The server runs on **a different machine** — not feasible to invoke via stdio
- The server needs to **maintain state** between connections (e.g. a database session pool)
- The tool is written in a language or framework better suited to a persistent HTTP service

### Docker Note

If you are running amazing-hashbrown in Docker and the SSE server is on the host machine, use `host.docker.internal` instead of `localhost`:

```json
"url": "http://host.docker.internal:3001/sse"
```

### Authentication

If the server requires authentication, consult its documentation. Common patterns include:

- A token in the URL query string: `http://server:3001/sse?token=abc123`
- A `headers` field in the config entry (supported by some server implementations)

See [[How to Add an SSE-Based Remote MCP Server]] for a step-by-step walkthrough and [[MCP Transports: stdio vs SSE]] for a comparison with stdio.
