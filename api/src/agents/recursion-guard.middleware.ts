import { interrupt } from '@langchain/langgraph';
import { isAIMessage, isToolMessage, isHumanMessage, HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { LoopGuardConfig } from '../config/env.js';
import { evaluateLoopProgress } from './loop-reflection.js';

// Thrown instead of calling interrupt() when this middleware is running in
// "throw" escalation mode (sub-agent runs — interrupt() has nothing watching
// to resume it there). Caught by task-execution.ts's catch chain and routed
// to deliverSubAgentCompletion, the same reporting path a cancelled or
// failed sub-agent run already uses.
export class StagnationLimitError extends Error {
  constructor(
    public readonly summary: string,
    public readonly reason: 'stagnation' | 'streak' | 'step_limit',
  ) {
    super('Stagnation limit reached');
    this.name = 'StagnationLimitError';
  }
}

// Mirrors after-agent.ts's AfterAgentContextSchema — the same context object
// already passed to agent.streamEvents() at every call site carries
// provider/model, so reflection can run on the live turn's own model rather
// than a hardcoded default.
const RecursionGuardContextSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
});

export interface RecursionGuardOptions {
  recursionLimit: number;
  warnThreshold: number;
  // Omitted or `{ enabled: false }` reproduces today's behavior exactly —
  // only the step-count check-in below runs.
  loopGuard?: LoopGuardConfig;
  // 'interrupt' (default): chat/task runs — pauses and waits for a human,
  // same as the existing step-count check-in.
  // 'throw': sub-agent runs — nothing can ever answer an interrupt() there,
  // so every reason (including step-count exhaustion) stops the run and
  // reports back to the parent instead.
  escalationMode?: 'interrupt' | 'throw';
  // Test-only escape hatch: an injected replacement for the real
  // evaluateLoopProgress(), same pattern as after-agent.ts's `llm`/`registry`
  // test-only params — lets unit tests reach the reflection rung without a
  // real model call. Production callers never set this.
  evaluateLoopProgress?: typeof evaluateLoopProgress;
}

// Strips ISO-8601 timestamp substrings and surrounding whitespace before
// comparing tool output — two otherwise-identical calls shouldn't be judged
// "different" purely because a timestamp in the output ticked forward.
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeToolOutput(content: any): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.replace(ISO_TIMESTAMP_RE, '').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolMessageName(msg: any): string {
  return msg.name ?? 'unknown_tool';
}

// Walks backward from the most recent ToolMessage, counting the trailing run
// that shares its tool name and normalized output. Stops at the first
// non-matching entry. Derived fresh from state.messages every call — no
// persisted counter to lose on a resume.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeStagnationStreak(toolMessages: any[]): number {
  if (toolMessages.length === 0) return 0;
  const last = toolMessages[toolMessages.length - 1];
  const lastName = toolMessageName(last);
  const lastOutput = normalizeToolOutput(last.content);
  let streak = 0;
  for (let i = toolMessages.length - 1; i >= 0; i--) {
    const msg = toolMessages[i];
    if (toolMessageName(msg) === lastName && normalizeToolOutput(msg.content) === lastOutput) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

// Walks backward over the full message list counting consecutive tool-call
// turns (an AIMessage carrying a tool call) regardless of which tool or
// whether the output repeated — resets at the first plain-text AIMessage or
// HumanMessage. Catches the "20 different-looking calls, never pausing to
// explain itself" shape that stagnation alone cannot see.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeRawStreak(messages: any[]): number {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isToolMessage(msg)) continue; // paired with the AIMessage counted below
    if (isAIMessage(msg)) {
      const hasToolCall = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCall) {
        streak += 1;
        continue;
      }
      break; // plain-text reply — the streak is broken
    }
    if (isHumanMessage(msg)) break;
    break;
  }
  return streak;
}

export function createRecursionGuardMiddleware(options: RecursionGuardOptions) {
  const {
    recursionLimit,
    warnThreshold,
    loopGuard,
    escalationMode = 'interrupt',
    evaluateLoopProgress: evaluateLoopProgressImpl = evaluateLoopProgress,
  } = options;
  const stepThreshold = Math.floor(recursionLimit * warnThreshold);
  // Omitting `loopGuard` entirely (not just `{ enabled: false }`) reproduces
  // today's step-count-only behavior exactly — the four pre-existing call
  // sites this middleware had before this feature existed all did, and still
  // effectively do, by passing no loopGuard config at all.
  const loopGuardEnabled = loopGuard !== undefined && loopGuard.enabled !== false;

  // Escalates per the configured mode. In 'throw' mode every reason
  // (including step-count exhaustion) converges on the same stop-and-report
  // outcome, since there's nothing to resume an interrupt() into. In
  // 'interrupt' mode, 'step_limit' keeps today's unchanged
  // recursion_limit_warning shape; 'stagnation'/'streak' use the new
  // loop_stagnation_warning shape — both translate to a 'multiple_choice'
  // HITL prompt downstream (see stream-handler.ts's dispatchHitlPrompt).
  async function escalate(
    reason: 'stagnation' | 'streak' | 'step_limit',
    summary: string,
    question: string,
    extra: { stepsUsed?: number } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (escalationMode === 'throw') {
      throw new StagnationLimitError(summary, reason);
    }

    const choices = ['Continue working', 'Stop and summarize what you have done so far'];
    const answer = interrupt(
      reason === 'step_limit'
        ? {
            kind: 'recursion_limit_warning',
            question,
            choices,
            allowFreeText: true,
            stepsUsed: extra.stepsUsed,
            recursionLimit,
          }
        : {
            kind: 'loop_stagnation_warning',
            question,
            choices,
            allowFreeText: true,
            summary,
          },
    );

    if (typeof answer === 'string' && answer !== 'Continue working') {
      return { messages: [new HumanMessage(`[User guidance]: ${answer}`)] };
    }
    return undefined;
  }

  return createMiddleware({
    name: 'RecursionGuardMiddleware',
    contextSchema: RecursionGuardContextSchema,
    // beforeModel fires before every LLM call — it is included in loopEntryNode,
    // which is where the ReAct loop re-enters after each tool execution.
    // beforeAgent only runs once (at graph START), so it cannot intercept recursion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeModel: async (state: any, runtime: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = state.messages as any[];
      const completedSteps: number = messages.filter(isAIMessage).length;

      // --- Step-count check-in (existing behavior; now escalation-mode-aware) ---
      // Fire at multiples of threshold so the agent gets a fresh interval
      // between consecutive resumes (e.g., at 75, 150, …).
      if (completedSteps !== 0 && completedSteps % stepThreshold === 0) {
        return escalate(
          'step_limit',
          `Reached ${completedSteps} LLM calls without a check-in opportunity.`,
          `I've been working for ${completedSteps} LLM calls and want to check in before continuing. What would you like me to do?`,
          { stepsUsed: completedSteps },
        );
      }

      if (!loopGuardEnabled) return undefined;
      const cfg = loopGuard!;

      // --- Stagnation / raw-streak detection ---
      const toolMessages = messages.filter(isToolMessage);
      const stagnationStreak = computeStagnationStreak(toolMessages);
      const rawStreak = computeRawStreak(messages);

      // Nudge: fires exactly once per growing streak, no extra LLM call.
      if (stagnationStreak === cfg.stagnationNudgeThreshold) {
        const toolName = toolMessageName(toolMessages[toolMessages.length - 1]);
        return {
          messages: [
            new HumanMessage(
              `You've called \`${toolName}\` ${stagnationStreak} times in a row with ` +
                `materially the same result. Before trying again: state what you've ` +
                `actually confirmed so far, and either try a clearly different ` +
                `approach or conclude the investigation.`,
            ),
          ],
        };
      }

      // Reflection: reached either via stagnation persisting past the nudge,
      // or via a long raw streak with zero repeats — both genuinely need a
      // model's judgment call, not another counter.
      const reflectionReason: 'stagnation' | 'streak' | null =
        stagnationStreak === cfg.stagnationReflectionThreshold
          ? 'stagnation'
          : rawStreak === cfg.streakReflectionThreshold
            ? 'streak'
            : null;

      if (reflectionReason) {
        const k = Math.min(reflectionReason === 'stagnation' ? stagnationStreak : rawStreak, 15);
        const recentToolCalls = toolMessages.slice(-k).map((m) => ({
          toolName: toolMessageName(m),
          args: undefined,
          output: m.content,
        }));

        const result = await evaluateLoopProgressImpl({
          toolCallPairs: recentToolCalls,
          reason: reflectionReason,
          threadId: runtime?.configurable?.thread_id,
          taskId: runtime?.configurable?.taskId,
          provider: runtime?.context?.provider,
          model: runtime?.context?.model,
        });

        if (result.converging) {
          return { messages: [new HumanMessage(result.guidance ?? result.summary)] };
        }

        return escalate(
          reflectionReason,
          result.summary,
          `I don't think this is making progress. ${result.summary} What would you like me to do?`,
        );
      }

      return undefined;
    },
  });
}
