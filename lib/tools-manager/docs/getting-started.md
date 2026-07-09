# Getting Started

## 1. Install

`@tkottke90/tools-manager` is a private workspace package. Add it as a dependency in your workspace package:

```json
{
  "dependencies": {
    "@tkottke90/tools-manager": "*"
  }
}
```

Then run `npm install` from the workspace root.

## 2. Construct

The constructor is synchronous. Provide the path to a directory where `mcp.json` will be stored. The directory does not need to exist yet.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';

const tm = new ToolsManager({ configDir: './config' });
```

## 3. Boot

`boot()` creates `configDir` if it is absent, writes an empty `mcp.json` on first run, and loads any existing config on subsequent runs. Always call `boot()` before using the manager.

```ts
await tm.boot();
```

## 4. Register built-in tools

The api layer is responsible for wrapping library methods into `RegisteredTool` objects and calling `register()`. Built-in tools are never persisted to disk — re-register them on each `boot()`.

```ts
import { z } from 'zod';

tm.register({
  name: 'wiki-orient',
  description: 'List top-level pages in the wiki',
  parameters: z.object({ query: z.string().optional() }),
  source: 'builtin',
  execute: async (args) => wiki.orient(args as { query?: string }),
});

tm.register({
  name: 'rlm-run',
  description: 'Run the Read-Learn-Memorize cycle',
  parameters: z.object({ topic: z.string() }),
  source: 'builtin',
  execute: async (args) => rlm.run(args as { topic: string }),
});
```

## 5. Add MCP servers

MCP servers are persisted to `mcp.json` and survive restarts. You can add them programmatically or import an existing config file.

```ts
// Add a stdio server
await tm.addMcpServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs'],
});

// Import an existing mcp.json (REPLACE semantics — replaces all existing servers)
await tm.importMcpConfig('/path/to/existing/.mcp.json');
```

## 6. Use in an agent turn

```ts
import type { OllamaInferenceAdapter } from '@tkottke90/inference-adapter';

async function agentTurn(adapter: OllamaInferenceAdapter, messages: Message[]) {
  // Get definitions to pass to the model
  const tools = await tm.getTools();

  const response = await adapter.invoke(messages, { tools });

  // Execute any tool calls the model requested
  for (const call of response.toolCalls ?? []) {
    const result = await tm.execute(call);
    // append result to messages...
  }
}

// When shutting down
await tm.close();
```
