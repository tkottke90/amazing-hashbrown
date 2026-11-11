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
  // Closure-bound task id for a task run, same pattern makeUpdatePlanTool/
  // create_tasks' callingTaskId use — tags this run's loop-guard reflection
  // trace with its real task id instead of reading it off
  // runtime.configurable (chat/workspace-chat/sub-agent runs have no task
  // to tag and omit this).
  taskId?: string;
  // Test-only escape hatch: an injected replacement for the real
  // evaluateLoopProgress(), same pattern as after-agent.ts's `llm`/`registry`
  // test-only params — lets unit tests reach the reflection rung without a
  // real model call. Production callers never set this.
  evaluateLoopProgress?: typeof evaluateLoopProgress;
  // 'throw' mode only: whether a `complete_task` call has already been
  // accepted on this run. Checked before ever escalating a second time on
  // the same trigger — a Sub-Agent Task's Run gets one Delivery Nudge, not
  // an unconditional kill, the moment it actually delivers. Omitted by every
  // 'interrupt'-mode caller (chat/task runs have no equivalent concept).
  // See GLOSSARY.md § Loop Guard, ADR-0062.
  hasDelivered?: () => boolean;
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

// Marker set on the loop guard's own injected nudge HumanMessage (see the
// nudge branch in beforeModel below) so computeStagnationStreak's window
// boundary can tell it apart from a genuine new human turn.
const NUDGE_MARKER = { loopGuardKind: 'nudge' } as const;

// A plain-text AIMessage (no tool_calls) or a HumanMessage marks the start of
// a new conversation turn the gap-tolerant scan below shouldn't reach
// behind — except the loop guard's own nudge, also a HumanMessage but
// tagged with NUDGE_MARKER: it's part of the very stagnation being
// measured, not a fresh turn, so a model that keeps looping right past it
// still needs to be able to reach the reflection threshold. Scoped to
// computeStagnationStreak only — computeRawStreak is untouched and keeps
// its own, unrelated boundary check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isStagnationWindowBoundary(msg: any): boolean {
  if (isAIMessage(msg)) {
    return !(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
  }
  if (isHumanMessage(msg)) {
    return msg.additional_kwargs?.loopGuardKind !== NUDGE_MARKER.loopGuardKind;
  }
  return true;
}

// Marker for the throw-mode-only "wrap it up" nudge — distinct from
// NUDGE_MARKER's "try something different" nudge: this one asks for an
// ending, not a different approach, so it deliberately isn't recognized by
// isStagnationWindowBoundary above — a Delivery Nudge SHOULD act as a fresh
// boundary (the model's behavior after it is what's being judged next, not
// blended with pre-nudge churn). Carries which of the three triggers fired
// it so step-count/stagnation/streak each track their own one-shot grace
// independently. See GLOSSARY.md § Loop Guard, ADR-0062.
type DeliveryNudgeReason = 'stagnation' | 'streak' | 'step_limit';

function deliveryNudgeMarker(reason: DeliveryNudgeReason) {
  return { loopGuardKind: 'delivery-nudge', deliveryNudgeReason: reason } as const;
}

// A Sub-Agent Task's Run is always a single Turn — no resume, no multi-turn
// thread (see GLOSSARY.md § Sub-Agent Task) — so scanning the whole message
// list for a prior Delivery Nudge is safe: there's no earlier, unrelated
// Turn's nudge it could mistake for this one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasDeliveryNudgeFired(messages: any[], reason: DeliveryNudgeReason): boolean {
  return messages.some(
    (m) =>
      isHumanMessage(m) &&
      m.additional_kwargs?.loopGuardKind === deliveryNudgeMarker(reason).loopGuardKind &&
      m.additional_kwargs?.deliveryNudgeReason === reason,
  );
}

function deliveryNudgeMessage(reason: DeliveryNudgeReason): HumanMessage {
  return new HumanMessage({
    content:
      'Stop investigating now and call `complete_task` with whatever you have confirmed so ' +
      'far — there is no further grace after this.',
    additional_kwargs: { ...deliveryNudgeMarker(reason) },
  });
}

// Walks backward from the most recently called tool, counting every prior
// ToolMessage that shares its tool name and normalized output — skipping
// over (not stopping at) calls to other tools in between, so an alternating
// shape (toolA, toolB, toolA, toolB, ...) where each tool keeps repeating
// its own output is still caught. Only stops at a window boundary (see
// isStagnationWindowBoundary). Anchoring to the most recently called tool's
// own count (rather than a max across every tool seen) is what keeps the
// "fires exactly once per crossing" property intact — a multi-tool max
// could sit flat at the threshold across several unrelated turns. Derived
// fresh from state.messages every call — no persisted counter to lose on a
// resume.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeStagnationStreak(messages: any[]): number {
  // Typed explicitly as any[] — isToolMessage is a type guard, so
  // .filter(isToolMessage) would otherwise narrow this to ToolMessage[],
  // and indexing that under noUncheckedIndexedAccess makes `last` possibly
  // undefined even right after the length check below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolMessages: any[] = messages.filter(isToolMessage);
  if (toolMessages.length === 0) return 0;
  const last = toolMessages[toolMessages.length - 1];
  const lastName = toolMessageName(last);
  const lastOutput = normalizeToolOutput(last.content);

  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isToolMessage(msg)) {
      if (toolMessageName(msg) === lastName && normalizeToolOutput(msg.content) === lastOutput) {
        streak += 1;
      }
      continue; // non-matching tool call: skip over it, keep scanning
    }
    if (isStagnationWindowBoundary(msg)) break;
    // AIMessage carrying a tool call, or the loop guard's own nudge: pass
    // through, neither is a boundary.
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
    taskId,
    evaluateLoopProgress: evaluateLoopProgressImpl = evaluateLoopProgress,
    hasDelivered,
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
      if (escalationMode === 'throw' && hasDeliveryNudgeFired(messages, 'step_limit')) {
        // Already nudged once for step-count — the real throw can't wait
        // for the next periodic crossing below, since recursionLimit isn't
        // guaranteed to land on a multiple of stepThreshold (see ADR-0062),
        // so it's checked here, on every call, independent of the periodic
        // guard. Falls through to the stagnation/streak checks below either
        // way — this trigger having already nudged doesn't suppress them.
        if (completedSteps >= recursionLimit && !hasDelivered?.()) {
          return escalate(
            'step_limit',
            `Reached ${completedSteps} LLM calls after already being asked to wrap up.`,
            `I've been working for ${completedSteps} LLM calls and want to check in before continuing. What would you like me to do?`,
            { stepsUsed: completedSteps },
          );
        }
      } else if (completedSteps !== 0 && completedSteps % stepThreshold === 0) {
        // Fire at multiples of threshold so the agent gets a fresh interval
        // between consecutive resumes (e.g., at 75, 150, …) — in 'throw'
        // mode, this first crossing injects a Delivery Nudge instead of
        // escalating immediately (see GLOSSARY.md § Loop Guard, ADR-0062).
        if (escalationMode === 'throw') {
          return { messages: [deliveryNudgeMessage('step_limit')] };
        }
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
      const stagnationStreak = computeStagnationStreak(messages);
      const rawStreak = computeRawStreak(messages);

      // Nudge: fires exactly once per growing streak, no extra LLM call.
      if (stagnationStreak === cfg.stagnationNudgeThreshold) {
        const toolName = toolMessageName(toolMessages[toolMessages.length - 1]);
        return {
          messages: [
            new HumanMessage({
              content:
                `You've called \`${toolName}\` ${stagnationStreak} times recently with ` +
                `materially the same result. Before trying again: state what you've ` +
                `actually confirmed so far, and either try a clearly different ` +
                `approach or conclude the investigation.`,
              additional_kwargs: { ...NUDGE_MARKER },
            }),
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
          taskId,
          provider: runtime?.context?.provider,
          model: runtime?.context?.model,
        });

        if (result.converging) {
          return { messages: [new HumanMessage(result.guidance ?? result.summary)] };
        }

        if (escalationMode === 'throw') {
          if (!hasDeliveryNudgeFired(messages, reflectionReason)) {
            return { messages: [deliveryNudgeMessage(reflectionReason)] };
          }
          if (hasDelivered?.()) {
            return undefined;
          }
          // Already nudged on this same streak and still not converging,
          // with nothing delivered in between — fall through to the real
          // throw below. See GLOSSARY.md § Loop Guard, ADR-0062.
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
