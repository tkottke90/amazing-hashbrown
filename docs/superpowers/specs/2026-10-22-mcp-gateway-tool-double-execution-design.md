# MCP Tool Double-Execution Fix

Fixes [#353](https://github.com/tkottke90/amazing-hashbrown/issues/353): every MCP tool call was producing two tool-call observability spans per model-requested call, logged under two different names.

## Problem

In a chat thread whose model requested exactly one call to an MCP tool, the observability trace recorded two `tool-call` spans for it: one named by the tool's Bound Name (see `GLOSSARY.md` § MCP Tooling), one named by the tool's bare `name`. Built-in/native tools never showed this. The thread's Thread Report (which reports at the model-tool_calls level, not the raw span level) only ever showed one call, so the duplication was invisible outside the raw trace.

## Root Cause

`lib/tools-manager/src/internal/mcp-client.ts`'s `fromLangChain()` constructs a `RegisteredTool.execute` that calls the underlying `@langchain/mcp-adapters` tool's `.invoke()`. `api/src/agents/chat-agent.ts`'s `mcpToolToLangChain()` wraps every such `RegisteredTool` in a second LangChain tool, bound under its Bound Name, whose own execution body calls that `RegisteredTool.execute` — i.e. a second, nested `.invoke()` call.

LangChain's `Tool.invoke()` resolves its run config via `ensureConfig()`, which pulls the ambient callback/trace context when no explicit config is given, and unconditionally fires `handleToolStart`/`handleToolEnd` against it. Both the outer (ToolNode-triggered) and inner (nested) `.invoke()` calls inherit the same ambient context, so each produces its own independent span: the outer one named by Bound Name, the inner one by the tool's bare `name`.

Confirmed: the real downstream request happens exactly once. mcphub's own request log for the reported incident shows a single `CallToolRequest`/`tools/call` and a single real HTTP fetch for the duplicated call. Tool-call spans also carry `null` input/output token counts (`observability-handler.ts`); this app's token/cost accounting is derived only from LLM-call spans. The duplication is confined to the observability layer — it does not double the external request, and does not double LLM token cost.

This also rules out the two other mechanisms considered during investigation: LangGraph's `ToolNode` dispatches exactly one `runTool` per entry in the model's `tool_calls` array (lookup via `.find()`, never fanning out to multiple matches), and `@langchain/mcp-adapters`'s own `_callTool()` makes exactly one `callTool()` request with no retry. Neither is in play here.

## Fix

In `fromLangChain()`, change the inner call from `tool.invoke(args)` to `tool.invoke(args, { callbacks: [] })`, so it stops inheriting the ambient callback manager and no longer fires its own `handleToolStart`/`handleToolEnd` pair, while keeping `.invoke()`'s input validation and error normalization.

See `docs/adr/0043-mcp-tool-invoke-suppresses-nested-callbacks.md` for why this approach was chosen over bypassing `.invoke()` entirely or adding a dedup/coalescing layer.

## Testing

Add a case to `lib/tools-manager/test/internal/mcp-client.test.ts` (External Orchestration, per the root `AGENTS.md` taxonomy — this is the boundary with `@langchain/mcp-adapters`): build a `RegisteredTool` via `fromLangChain()` from a fake LangChain tool whose `invoke` is a spy, call the resulting `RegisteredTool.execute(args)`, and assert the spy was called with `(args, { callbacks: [] })`. This file already has a `fakeClient`/fixture pattern for this module to extend.

## Non-Goals

- No dedup/coalescing logic — there is no real duplicate execution to coalesce against (see Root Cause).
- No change to how Bound Names are derived, to `ToolsManager.execute()`, to `ToolNode`, or to `@langchain/mcp-adapters` itself — all were investigated and ruled out as the cause.
- No attempt to reproduce this live against a real mcphub instance — the fix and its test are verified from the confirmed mechanism and the reporter's own trace/logs; the reporter will validate against their own mcphub setup before merge.
- Does not address the separately-tracked context-window-trimming symptom mentioned in the original issue's Dev Notes — that remains its own issue.

## References

- Issue: [#353](https://github.com/tkottke90/amazing-hashbrown/issues/353)
- `GLOSSARY.md` § MCP Tooling (MCP Server, Bound Name)
- `docs/adr/0043-mcp-tool-invoke-suppresses-nested-callbacks.md`
