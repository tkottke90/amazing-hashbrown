# MCP tool execution suppresses callback propagation on its inner invoke

Fixing issue #353 (duplicate MCP tool-call trace spans): `fromLangChain()`'s `RegisteredTool.execute` calls the underlying `@langchain/mcp-adapters` tool via `tool.invoke(args, { callbacks: [] })` rather than `tool.invoke(args)`. Every LangChain tool's `.invoke()` fires its own `handleToolStart`/`handleToolEnd` against whatever callback manager it inherits from the ambient trace context, so calling it from inside another tool's own execution — `mcpToolToLangChain()` wraps every `RegisteredTool` in a second LangChain tool bound under its Bound Name — produced two independent spans for one real execution (confirmed only one real `CallToolRequest` reaches the MCP server). We suppress callback inheritance on this inner call specifically, rather than bypassing `.invoke()` entirely, to keep its input validation and error normalization and lose only the unwanted duplicate span.

## Considered Options

- Bypass `.invoke()` and call the tool's internal `_call`/`func` directly — rejected: reaches into `@langchain/mcp-adapters`'s non-public API surface and loses `.invoke()`'s input validation/error normalization.
- Dedupe/coalesce concurrent identical calls at this boundary — rejected: there is no real duplicate execution to dedupe against (mcphub's own request log showed a single `CallToolRequest`); the duplication is confined to observability spans, so a dedup layer would have added complexity to fix a problem that doesn't exist at the execution level.
