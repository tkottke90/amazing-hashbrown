## MCP Transports: stdio vs SSE

MCP servers communicate with amazing-hashbrown over one of two transports: **stdio** and **SSE**. The transport type determines how the app connects to the server and who manages the server's lifecycle.

### stdio

With stdio, amazing-hashbrown spawns the MCP server as a child process and communicates with it over stdin and stdout. The app starts the server when it launches and stops it when it shuts down.

**Best for:**

- Local tools that wrap the file system, databases, or CLI utilities
- Servers you want the app to manage automatically
- Single-user setups where no network sharing is needed
- Situations where you don't want to run a persistent background service

**Example entry in `mcp.json`:**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

No network port is needed. The server process is invisible to the rest of the system.

### SSE (Server-Sent Events)

With SSE, amazing-hashbrown connects to a remote HTTP server using Server-Sent Events. The server must already be running and reachable before the connection is attempted. The app does not start or stop the server.

**Best for:**

- Servers shared across a team or multiple machines
- Servers that need to maintain state between connections
- Tools running on a different host or in a container
- Servers written in languages or frameworks that are easier to run as a long-lived service

**Example entry in `mcp.json`:**

```json
{
  "mcpServers": {
    "remote-tools": {
      "transport": "sse",
      "url": "http://192.168.1.50:3001/sse"
    }
  }
}
```

### Choosing Between Them

For most personal or single-developer setups, **stdio is simpler** — you configure a command and the app handles the rest. Use **SSE** when the server needs to be shared, runs on a different machine, or requires a persistent process that outlives the app session.

See [[MCP stdio Server]] and [[MCP SSE Server]] for full configuration details.
