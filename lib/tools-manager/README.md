# @tkottke90/tools-manager

Manages tool registration and dispatch for the local LLM agent harness. Built-in tools (registered programmatically by the api layer) and MCP server tools (discovered at runtime) are unified behind a single interface. The package maintains a persistent `mcp.json` config file and never leaks LangChain types to callers.

## MCP config format

`mcp.json` follows the same shape used by Claude Desktop and most MCP clients:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "remote-server": {
      "transport": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## Quick start

```ts
import { ToolsManager } from '@tkottke90/tools-manager';
import { z } from 'zod';

const tm = new ToolsManager({ configDir: './config' });
await tm.boot();

// Register a built-in tool
tm.register({
  name: 'wiki-orient',
  description: 'Orient within the wiki',
  parameters: z.object({ query: z.string() }),
  source: 'builtin',
  execute: async (args) => wiki.orient(args as { query: string }),
});

// Add an MCP server at runtime
await tm.addMcpServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
});

// Get all tool definitions for the adapter
const tools = await tm.getTools();

// Execute a tool call returned by the model
const result = await tm.execute({ name: 'wiki-orient', arguments: { query: 'intro' } });

await tm.close();
```

## Documentation

- [Getting started](docs/getting-started.md)
- [API reference](docs/api.md)
- [Examples](docs/examples.md)
