## How to Add an SSE-Based Remote MCP Server

This guide walks through connecting amazing-hashbrown to a remote MCP server using the SSE transport. Unlike stdio servers, an SSE server runs independently and the app connects to it over HTTP.

### Prerequisites

- The remote MCP server must be **running and accessible** from the machine where amazing-hashbrown is running.
- You need the server's SSE endpoint URL (typically `http://<host>:<port>/sse`).

### Steps

1. Confirm the server is reachable. From the host running amazing-hashbrown, check that the URL is accessible (e.g. with `curl http://192.168.1.50:3001/sse`).

2. Open `mcp.json` (located at `./config/mcp.json` for local installs, `./data/mcp.json` in Docker).

3. Add the server entry:

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

4. Restart amazing-hashbrown. The remote server's tools will be merged into the agent's tool set.

### Tips

- **Use the correct host.** Use the server's local network IP or hostname, not `localhost`, unless the server is on the same machine as amazing-hashbrown.

- **Docker host access.** If amazing-hashbrown is running in Docker and the SSE server is on the host machine, use `host.docker.internal` instead of `localhost`:

  ```json
  "url": "http://host.docker.internal:3001/sse"
  ```

- **Authentication.** If the server requires a token or API key, check the server's documentation. Many servers accept credentials as a query parameter in the URL:

  ```json
  "url": "http://192.168.1.50:3001/sse?token=abc123"
  ```

  Some server implementations also support a `headers` config field for passing `Authorization` headers.

- **Startup order matters.** The SSE server must be running before amazing-hashbrown attempts to connect. If you restart the MCP server while the app is running, use the **Reload MCP Config** option (if available) rather than restarting the whole app.

- **Multiple SSE servers.** You can list as many SSE servers as needed alongside stdio servers in the same `mcp.json` file. All tools are merged at startup.

See [[MCP SSE Server]] for the full config reference and [[MCP Transports: stdio vs SSE]] for a comparison with local stdio servers.
