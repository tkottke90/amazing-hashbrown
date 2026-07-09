# Examples

## 1. Wrapping an llm-wiki method as a RegisteredTool

The api layer imports both the tool manager and the wiki, then wraps wiki methods into `RegisteredTool` objects before calling `register()`.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';
import { LlmWiki } from '@tkottke90/llm-wiki';
import { z } from 'zod';

const wiki = new LlmWiki({ dataDir: './wiki-data' });
const tm = new ToolsManager({ configDir: './config' });
await tm.boot();

tm.register({
  name: 'wiki-orient',
  description: 'List top-level pages and their one-line summaries',
  parameters: z.object({}),
  source: 'builtin',
  execute: async () => wiki.orient(),
});

tm.register({
  name: 'wiki-search',
  description: 'Semantic search across wiki pages',
  parameters: z.object({ query: z.string() }),
  source: 'builtin',
  execute: async ({ query }) => wiki.semanticSearch(query as string),
});

tm.register({
  name: 'wiki-read',
  description: 'Read the full content of a wiki page',
  parameters: z.object({ slug: z.string() }),
  source: 'builtin',
  execute: async ({ slug }) => wiki.readPage(slug as string),
});
```

---

## 2. Seeding config from an existing MCP JSON file path

Pass a file path string to `importMcpConfig`. The file is read, validated, and its contents **replace** any existing MCP server config.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';
import { homedir } from 'node:os';
import { join } from 'node:path';

const tm = new ToolsManager({ configDir: './config' });
await tm.boot();

// Import from Claude Desktop's default location
const claudeMcpPath = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);
await tm.importMcpConfig(claudeMcpPath);

console.log(tm.listMcpServers());
```

---

## 3. Seeding config from a Buffer (e.g. uploaded via API)

When an MCP config is received as raw bytes (HTTP upload, multipart form), pass the Buffer directly.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';

const tm = new ToolsManager({ configDir: './config' });
await tm.boot();

// In an Express handler:
app.post('/mcp-config', express.raw({ type: 'application/json' }), async (req, res) => {
  await tm.importMcpConfig(req.body as Buffer);
  res.json({ servers: tm.listMcpServers() });
});
```

---

## 4. Programmatic MCP server CRUD

Add, update, and remove servers at runtime — useful for a settings UI.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';

const tm = new ToolsManager({ configDir: './config' });
await tm.boot();

// Add a filesystem server
await tm.addMcpServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs'],
});

// Restrict to a different directory
await tm.editMcpServer('filesystem', {
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/projects'],
});

// Add a remote SSE server
await tm.addMcpServer('remote', {
  transport: 'sse',
  url: 'http://localhost:3001/sse',
  headers: { Authorization: 'Bearer token' },
});

// Remove the remote server
await tm.removeMcpServer('remote');

// Inspect current config
console.log(tm.listMcpServers());

await tm.close();
```

---

## 5. Filtering tools by a skill's allowed-tools frontmatter

Skills can declare which tools they need via an `allowed-tools` frontmatter field (comma-separated names). Pass the parsed list as the `filter` argument to `getTools()`.

```ts
import { ToolsManager } from '@tkottke90/tools-manager';
import { SkillsManager } from '@tkottke90/skills-manager';

const tm = new ToolsManager({ configDir: './config' });
const sm = new SkillsManager({ configDir: './config' });
await Promise.all([tm.boot(), sm.boot()]);

async function runSkill(skillName: string, messages: Message[]) {
  const skill = sm.get(skillName);

  // Parse the comma-separated allowed-tools frontmatter value
  const allowedTools = skill?.frontmatter['allowed-tools']
    ?.split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  // undefined means "all tools"; empty array means "no tools"
  const tools = await tm.getTools(allowedTools);

  return adapter.invoke(messages, { tools, systemPrompt: skill?.content });
}
```
