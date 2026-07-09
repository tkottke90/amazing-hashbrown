# API Reference

## `ToolsManager`

```ts
import { ToolsManager } from '@tkottke90/tools-manager';
```

### Constructor

```ts
new ToolsManager(opts: { configDir: string })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `opts.configDir` | `string` | Directory where `mcp.json` is stored. Created on `boot()` if absent. |

---

### `boot(): Promise<void>`

Initialises the manager. Creates `configDir` if needed, writes an empty `mcp.json` on first run, loads existing config on subsequent runs, and creates the MCP client. Must be called before any other method.

```ts
await tm.boot();
```

---

### `close(): Promise<void>`

Closes all MCP connections and clears cached tool state. Call on shutdown.

```ts
await tm.close();
```

---

### `register(tool: RegisteredTool): void`

Registers a built-in tool. Built-in tools take priority over MCP tools during dispatch. Re-register on every `boot()` — built-ins are not persisted.

```ts
tm.register({
  name: 'echo',
  description: 'Echo the input',
  parameters: z.object({ text: z.string() }),
  source: 'builtin',
  execute: async ({ text }) => text,
});
```

---

### `getTools(filter?: string[]): Promise<ToolDefinition[]>`

Returns tool definitions (name, description, parameters — no `execute`) suitable for passing to an inference adapter. Lazily initialises MCP connections on first call.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter` | `string[]` (optional) | If provided, only tools whose names appear in this list are returned. An empty array returns all tools. |

```ts
const all = await tm.getTools();
const subset = await tm.getTools(['wiki-orient', 'rlm-run']);
```

---

### `execute(call: ToolCall): Promise<unknown>`

Dispatches a tool call. Built-ins are checked first, then MCP tools. Lazily initialises MCP connections if needed.

| Parameter | Type | Description |
|-----------|------|-------------|
| `call.name` | `string` | Tool name. |
| `call.arguments` | `Record<string, unknown>` | Arguments from the model. |

**Throws:** `Error: Unknown tool: "<name>"` if no tool with that name is registered.

```ts
const result = await tm.execute({ name: 'echo', arguments: { text: 'hello' } });
```

---

### `list(): RegisteredTool[]`

Returns all registered tools (builtins + any already-fetched MCP tools) without triggering MCP initialisation.

```ts
const tools = tm.list();
```

---

### `importMcpConfig(source: string | Buffer): Promise<void>`

Imports an MCP config, **replacing** all existing servers. Accepts a file path string or a Buffer containing JSON.

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | `string \| Buffer` | File path or JSON Buffer. |

**Throws:** `Error` if the JSON is invalid or missing `mcpServers`.

```ts
// From a file path
await tm.importMcpConfig('/path/to/mcp.json');

// From a Buffer (e.g. an uploaded file)
await tm.importMcpConfig(fileBuffer);
```

---

### `addMcpServer(name: string, config: McpServerConfig): Promise<void>`

Adds a new MCP server. Persists to `mcp.json` and resets the MCP client.

**Throws:** `Error: MCP server "<name>" already exists` if the name is already registered.

```ts
await tm.addMcpServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
});
```

---

### `editMcpServer(name: string, config: Partial<McpServerConfig>): Promise<void>`

Updates fields on an existing MCP server. Merges the provided fields with the existing config. Persists and resets the MCP client.

**Throws:** `Error: MCP server "<name>" not found` if the name is not registered.

```ts
await tm.editMcpServer('filesystem', { cwd: '/home/user/docs' });
```

---

### `removeMcpServer(name: string): Promise<void>`

Removes an MCP server. Persists and resets the MCP client.

**Throws:** `Error: MCP server "<name>" not found` if the name is not registered.

```ts
await tm.removeMcpServer('filesystem');
```

---

### `listMcpServers(): Record<string, McpServerConfig>`

Returns a shallow copy of the current MCP server config. Does not trigger MCP initialisation.

```ts
const servers = tm.listMcpServers();
// { filesystem: { command: 'npx', args: [...] } }
```

---

## Types

### `RegisteredTool`

```ts
interface RegisteredTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  source: 'builtin' | 'mcp';
  mcpServer?: string;        // present when source === 'mcp'
  execute(args: Record<string, unknown>): Promise<unknown>;
}
```

### `McpStdioConfig`

```ts
interface McpStdioConfig {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}
```

### `McpHttpConfig`

```ts
interface McpHttpConfig {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  reconnect?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}
```

### `McpServerConfig`

```ts
type McpServerConfig = McpStdioConfig | McpHttpConfig;
```

### `McpConfigFile`

```ts
interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}
```

### `ToolDefinition` (re-exported from `@tkottke90/inference-adapter`)

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
}
```

### `ToolCall` (re-exported from `@tkottke90/inference-adapter`)

```ts
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
```
