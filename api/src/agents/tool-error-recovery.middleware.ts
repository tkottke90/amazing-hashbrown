import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';

// langchain's ToolNode treats ANY tool-execution error as "from middleware"
// whenever at least one wrapToolCall middleware is registered on the agent
// (always true for this app's agents) — and its default handleToolErrors is
// a function, never the literal boolean `true`, so that class of error is
// always rethrown rather than converted into a recoverable ToolMessage.
// Confirmed directly from langchain@1.5.16's dist/agents/nodes/ToolNode.cjs:
// `if (errorFromMiddleware && this.handleToolErrors !== true) throw effectiveError;`.
// @langchain/mcp-adapters hits this every time an MCP server returns an
// error result (it throws its own ToolException rather than returning error
// text), which is what turns an ordinary tool failure into a crashed turn —
// see docs/superpowers/specs/2026-11-22-tool-call-error-recovery-middleware-design.md.
//
// isGraphBubbleUp is the exclusion: LangGraph's own control-flow signals
// (interrupt(), used by shell_exec approval, recursion/loop-stagnation
// warnings, and ask_user itself) are thrown as GraphBubbleUp subclasses and
// must propagate untouched, or HITL breaks instead of this bug.
export function createToolErrorRecoveryMiddleware() {
  return createMiddleware({
    name: 'ToolErrorRecoveryMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (isGraphBubbleUp(error)) throw error;
        logger.warn(
          'toolErrorRecoveryMiddleware: tool call failed, surfacing as a recoverable error',
          {
            toolName: request.toolCall.name,
            err: serializeError(error),
          },
        );
        return new ToolMessage({
          content: error instanceof Error ? error.message : String(error),
          tool_call_id: request.toolCall.id ?? randomUUID(),
          name: request.toolCall.name,
          status: 'error',
        });
      }
    },
  });
}

export const toolErrorRecoveryMiddleware = createToolErrorRecoveryMiddleware();
