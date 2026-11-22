# Tool-Call Error Recovery Middleware — Design

**Date:** 2026-11-22
**Status:** Approved
**Origin:** Thread-report investigation (`/debrief` + `/grilling`) into "when an MCP tool fails, the turn ends" — no tracked issue; this doc is the record of the investigation and the agreed fix.

---

## 1. Problem

In multiple conversations — interactive chat and, worse, automated task/headless runs where nobody is present to manually resume — a single failing tool call ends the entire agent turn instead of letting the model see the failure and continue. The user has to notice and re-prompt; in a non-interactive thread the run simply dies.

The reported case: an automated task run called an n8n MCP tool (`get_workflow_details`) against an archived workflow. The MCP server returned a tool-level error. The whole turn crashed with a generic `"Something went wrong"`, and the model had already retried the same broken call multiple times in-flight when the crash happened.

## 2. Root Cause

Traced to the exact pinned library versions this repo uses (`langchain@1.5.16`, `@langchain/mcp-adapters@1.1.3`, `@langchain/core@1.2.17`, `@langchain/langgraph@1.4.21`) by fetching and reading their published source — not guessed from general LangChain knowledge.

1. `@langchain/mcp-adapters` wraps every MCP tool call; when the server's `CallToolResult.isError` is `true`, it throws **its own locally-defined** `ToolException` class (`dist/tools.js`) — a plain `Error` subclass named `"ToolException"`, not imported from or recognized by `@langchain/core`.
2. This repo's `mcpToolToLangChain()` (`api/src/agents/chat-agent.ts`) wraps every MCP tool with `tool(async (args) => { const result = await t.execute(realArgs); ... })` — no `try`/`catch`, so that exception propagates unchanged.
3. All four `createAgent()` builders in `chat-agent.ts` (`buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent`, `buildSubAgentAgent`) register several `wrapToolCall` middlewares (skill gating, binary-content-fetch, tool-access, etc.). `createAgent`'s own parameter type (`langchain`'s `CreateAgentParams`) has **no field** to influence tool-error handling, and does not accept a pre-built `ToolNode` in place of a plain tool array — confirmed directly from `dist/agents/types.d.ts` and the `ReactAgent` constructor, which always builds its internal `ToolNode` with only `{ signal, wrapToolCall }`.
4. Inside `langchain`'s `ToolNode` (`dist/agents/nodes/ToolNode.cjs`): whenever **any** `wrapToolCall` middleware is registered on the agent (always true here), every tool-execution error is labeled `isMiddlewareError: true` — regardless of whether it actually originated in middleware logic or just passed cleanly through it from the real tool. Because the default `handleToolErrors` is a _function_ (`defaultHandleToolErrors`), not the literal boolean `true`, the check `errorFromMiddleware && this.handleToolErrors !== true` is always true for every such error — so it is **rethrown** rather than converted into a recoverable error `ToolMessage`.
5. The rethrown error crashes the whole LangGraph run. `stream-handler.ts`'s `pipeEvents`/`streamChatToSse` (and the identical pattern in `task-execution.ts`/`headless-turn.ts`) catch it, classify it `unknown` (`error-classification.ts` has no branch for a tool exception), and end the turn via `failAssistant` — the generic failure the user sees, and the reason a headless/task run simply dies with no one around to resume it.

This is **systemic**, not MCP-specific in mechanism: any tool whose logic throws (instead of returning an error string) hits the same wall under this app's agents, because they always have at least one `wrapToolCall` middleware bound. It surfaces disproportionately with MCP tools because `@langchain/mcp-adapters` converts ordinary MCP business errors into thrown exceptions, while this repo's own hand-written tools mostly return error text instead of throwing.

A critical adjacent fact: LangGraph's control-flow signals (`interrupt()`, used by `shell_exec` approval, recursion-limit warnings, loop-stagnation warnings, and `ask_user` itself) all throw too — as members of a `GraphBubbleUp` class family (`GraphInterrupt`, `NodeInterrupt`, `GraphDrained`, `ParentCommand`, per `@langchain/langgraph`'s `dist/errors.cjs`). `ToolNode` already special-cases these (`isGraphInterrupt` check in `#handleError`) and `langchain`'s own `MiddlewareError.wrap()` uses the broader `isGraphBubbleUp` check for the same reason. Any fix here must never catch a `GraphBubbleUp`, or it would silently break HITL approval/`ask_user` instead of fixing anything.

## 3. Decision

Add one new, generic `wrapToolCall` middleware — a repo-wide safety net, not an MCP-only patch — following this repo's "Composition over Customization" principle (`AGENTS.md`): one small mechanism every tool benefits from, including tools that don't throw today but might in the future, rather than a one-off patch scoped to today's known failure case.

### 3a. `toolErrorRecoveryMiddleware`

New file: `api/src/agents/tool-error-recovery.middleware.ts` (+ adjacent `.test.ts`, per this repo's standard middleware pattern).

A `createMiddleware({ name: 'ToolErrorRecoveryMiddleware', wrapToolCall: async (request, handler) => { ... } })`:

```ts
wrapToolCall: async (request, handler) => {
  try {
    return await handler(request);
  } catch (error) {
    if (isGraphBubbleUp(error)) throw error; // never swallow HITL/interrupt/sub-agent control flow
    logger.warn('toolErrorRecoveryMiddleware: tool call failed, surfacing as a recoverable error', {
      toolName: request.toolCall.name,
      err: serializeError(error),
    });
    return new ToolMessage({
      content: error instanceof Error ? error.message : String(error),
      tool_call_id: request.toolCall.id,
      name: request.toolCall.name,
      status: 'error',
    });
  }
};
```

Key decisions baked into this shape:

- **Safety boundary:** `isGraphBubbleUp` (imported from `@langchain/langgraph`) is the complete and only exclusion — matches the check `langchain`'s own `MiddlewareError.wrap()` uses. Anything else thrown is treated as a recoverable tool failure.
- **Catch breadth:** broad — any non-`GraphBubbleUp` thrown value is caught, mirroring `ToolNode`'s own `defaultHandleToolErrors` behavior for the no-middleware case (that's what "safe to recover" already means to the library itself).
- **Message content:** the raw underlying error message, passed through unmodified — no reformatting, no `"\nPlease fix your mistakes."` suffix. MCP's own `ToolException` text (`MCP tool 'X' on server 'Y' returned an error: ...`) is already specific and actionable for the model.
- **Logging:** a `logger.warn` on every catch, so a recovered failure (an MCP server down, a bad id) stays visible to anyone watching logs even though the turn itself no longer fails. Matches the existing pattern in `dispatchHitlPrompt`/`recoverThrownInterrupt` (`stream-handler.ts`).
- **No special-casing by error type** — `ToolException`, `ToolInvocationError` (the wrapper `ToolNode` itself applies for schema-parsing failures before this middleware ever sees it), or a plain `Error` from a hand-written tool are all handled identically.

### 3b. Wiring

Add `toolErrorRecoveryMiddleware` to the `middleware: [...]` array in **all four** `createAgent()` builders in `chat-agent.ts` (`buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent`, `buildSubAgentAgent`) — placed last among the `wrapToolCall`-bearing entries, immediately adjacent to tool execution, so it's unambiguously "the final safety net" rather than something another middleware's own `wrapToolCall` could preempt. (Position doesn't change correctness here — any `wrapToolCall` middleware that itself catches intercepts regardless of chain order — but placing it last keeps intent legible.)

No changes needed to `mcpToolToLangChain()` itself, nor to `task-execution.ts`/`headless-turn.ts` — both already build their agent through the same four `createAgent()` builders, so recovery applies automatically. A recovered run simply continues and finishes normally; there is nothing new to surface on the Kanban board or task-queue summary, because by definition a recovered run no longer ends in failure.

## 4. Deliberately deferred (not part of this fix)

- **Same-tool retry-loop prevention.** The reported thread showed the model retrying the same permanently-broken call multiple times before the crash. Once the error is a normal `ToolMessage`, the model should reason its way out of repeating it — ship recovery first; revisit explicit loop-breaking only if looping is still observed afterward.
- **A new `ChatErrorCategory` (e.g. `tool_error`).** Once most tool errors are recovered in-turn, a turn only still _ends_ on a tool failure in a genuinely unanticipated case (e.g. the middleware chain itself throwing). That residual case keeps falling to `unknown` in `error-classification.ts` rather than growing a category for an outcome this fix is specifically trying to make rare.
- **Oversized error-message capping/offload.** `mcpToolToLangChain()` already offloads huge _successful_ tool results via the existing stub/`tool-content-store` mechanism. An error message can theoretically be large too (`ToolInvocationError`'s message embeds a full stack trace), but this is deferred — ship the raw passthrough as-is, revisit only if an oversized error message is actually observed in practice.

## 5. Testing Plan

Orchestration test (`api/src/agents/tool-error-recovery.middleware.test.ts`), per this repo's established `wrapToolCall` middleware test pattern (see `binary-content-fetch.middleware.test.ts`, `skill-scoped-tools.middleware.test.ts`):

- A thrown plain `Error` from `handler()` is converted to a `ToolMessage` with `status: 'error'` and the original message as `content`.
- A thrown `ToolException`-shaped error (a plain `Error` subclass named `"ToolException"`, matching what `@langchain/mcp-adapters` actually throws) is handled identically — no special-casing.
- A thrown real `GraphInterrupt` instance (constructed from `@langchain/langgraph`, not hand-rolled, per this repo's external-boundary testing convention) is rethrown unchanged, not converted.
- A successful `handler()` call passes its result through untouched (`ToolMessage` or `Command`).
- The `logger.warn` call fires on the error path with the tool name, and does not fire on the success or bubble-up paths.

This is deterministic harness behavior (how a thrown JS error is classified and converted), not model-output-dependent — it belongs in this repo's Mocha/Chai developer-test suite per `AGENTS.md`'s existing convention, not an eval-harness scenario (EDD governs LLM-facing _behavior_, not this kind of deterministic control flow).

## 6. Files Changed (expected)

- `api/src/agents/tool-error-recovery.middleware.ts` (new) + test
- `api/src/agents/chat-agent.ts` — add the middleware to all four `createAgent()` builders' middleware arrays

## 7. Out of Scope

- Any turn-ending failure mode other than this one (e.g. `GraphRecursionError` is already handled gracefully elsewhere in `stream-handler.ts` and is unrelated to this bug).
- `shell_exec`'s approval flow and other `interrupt()`-based HITL mechanisms — explicitly protected by the `isGraphBubbleUp` check, not touched by this change.
