## How to Configure an MCP Server

MCP servers are configured in `mcp.json`, which lives in the MCP config directory. The default path is `./config/mcp.json` for local installs and `./data/mcp.json` when running in Docker. The file format is identical to Claude Desktop's MCP configuration, so configs can be shared between the two.

### Adding a stdio Server

1. Open `mcp.json` (create it if it doesn't exist).

2. Add your server under the `mcpServers` key:

   ```json
   {
     "mcpServers": {
       "my-server": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
       }
     }
   }
   ```

3. Restart amazing-hashbrown, or use the **Reload MCP Config** option in Settings if available.

4. The agent can now call the server's tools. You can confirm by asking it to list available tools, or simply try using one.

### Adding Multiple Servers

Add each server as a separate entry under `mcpServers`. Each must have a unique name (the name is a display label, not a protocol field):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

All servers' tools are merged into the agent's tool set at startup.

### Passing Environment Variables

Use the `env` field to inject secrets or configuration values into a server process without putting them in the command arguments:

```json
"env": {
  "API_KEY": "your-secret-key"
}
```

### Removing a Server

Delete the server's entry from `mcpServers` and restart the app. The tools it provided will no longer be available.

### Config Location

If you're unsure where `mcp.json` should live, check the **Settings** panel in the app UI — the MCP config path is displayed there.

See [[MCP stdio Server]] for stdio field details and [[MCP SSE Server]] for remote server configuration.
