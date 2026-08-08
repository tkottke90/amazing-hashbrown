## How MCP Works

MCP (Model Context Protocol) lets the agent use tools provided by external servers — without any code changes to amazing-hashbrown itself. It is a standardized protocol that separates tool _capability_ from tool _implementation_, so new tools can be added by plugging in a server rather than modifying the application.

### Startup and Discovery

When amazing-hashbrown starts, it reads `mcp.json` from the MCP config directory (default: `./config/mcp.json`, or `./data/mcp.json` in Docker). The file lists one or more MCP servers. For each server, the app:

1. Establishes a connection (spawning a process for stdio servers, or opening an HTTP connection for SSE servers).
2. Calls the server's `tools/list` endpoint to discover what tools it exposes.
3. Merges those tools into the agent's tool set alongside the built-in tools.

### What the Agent Sees

From the agent's perspective, MCP tools look identical to built-in tools. The agent calls them the same way, passes arguments the same way, and receives results the same way. There is no special syntax required — the agent simply sees a larger set of available tools.

### What You Can Add

Because any MCP-compatible server can be listed in `mcp.json`, you can extend the agent with almost any capability:

- **File system access** — read, write, and search files on disk
- **Database queries** — run SQL against PostgreSQL, SQLite, or other databases
- **GitHub integration** — open issues, list PRs, search code
- **Web search** — retrieve live search results
- **Calendar and email** — read and write calendar events or messages
- **Custom tools** — any server you build or find that speaks MCP

### Transport Types

MCP servers communicate with the app over one of two transports:

- **stdio** — the app spawns the server as a local child process
- **SSE** — the app connects to an already-running HTTP server

See [[MCP Transports: stdio vs SSE]], [[MCP stdio Server]], and [[MCP SSE Server]] for details on each transport type and how to configure them.
