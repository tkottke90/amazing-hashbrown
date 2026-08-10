## MCP stdio Server

A stdio MCP server is a process that amazing-hashbrown spawns and communicates with over stdin/stdout. The app manages the server's lifecycle: it starts the server on launch and stops it when the app exits.

### Configuration

stdio servers are configured in `mcp.json` under the `mcpServers` key:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
    }
  }
}
```

### Fields

- **`command`** — the executable to run. Common values: `npx`, `python3`, `node`, `uvx`, or an absolute path to a binary.
- **`args`** — an array of arguments passed to the command. Order matters and is passed through exactly.
- **`env`** — optional object of environment variables to inject into the server process. Use this for API keys and secrets the server needs:
  ```json
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
  }
  ```

The server name (e.g. `"filesystem"`) is an arbitrary label used for display and logging. It does not affect which tools the server provides — those are discovered automatically when the connection is established.

### Common stdio Servers

| Package                                     | What it provides                              |
| ------------------------------------------- | --------------------------------------------- |
| `@modelcontextprotocol/server-filesystem`   | Read and write files on disk                  |
| `@modelcontextprotocol/server-github`       | GitHub API (issues, PRs, code search)         |
| `@modelcontextprotocol/server-postgres`     | Run SQL queries against a PostgreSQL database |
| `@modelcontextprotocol/server-brave-search` | Web search via the Brave Search API           |

Most of these servers are installed and run via `npx` so no manual installation is required. The `-y` flag skips the `npx` install confirmation prompt.

### Multiple Servers

You can list multiple stdio servers in `mcp.json` at the same time. Each gets its own entry under `mcpServers` with a unique name. All of their tools are merged into the agent's tool set.

See [[How to Configure an MCP Server]] for a step-by-step setup guide and [[MCP Transports: stdio vs SSE]] for a comparison with SSE servers.
