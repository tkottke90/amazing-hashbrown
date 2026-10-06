import { z } from 'zod';
import { createProvider } from '../services/provider-factory.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { logger, serializeError } from '../config/logger.js';
import { invokeStructured } from './after-agent.js';

// ---------------------------------------------------------------------------
// The loop guard's "reflection" rung — a genuine judgment call ("is this
// actually converging?"), not something a counter can answer. Modeled
// directly on after-agent.ts's pipeline: its own small LLM call via the
// shared invokeStructured() helper, its own observability trace (source:
// 'loop-guard'), named span 'loop-guard:reflect'.
// ---------------------------------------------------------------------------

export const ReflectionResultSchema = z.object({
  converging: z.boolean(),
  summary: z.string(),
  guidance: z.string().optional(),
});

export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;

export interface EvaluateLoopProgressParams {
  // The last K tool-call/result pairs that triggered reflection (K is
  // bounded by the caller — see recursion-guard.middleware.ts).
  toolCallPairs: Array<{ toolName: string; args: unknown; output: unknown }>;
  reason: 'stagnation' | 'streak';
  threadId?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  // Test-only escape hatch: an already-constructed model, used in place of
  // createProvider(provider, model). Production callers never set this —
  // same pattern as after-agent.ts's RunAfterAgentPipelineParams.llm.
  llm?: ReturnType<typeof createProvider>;
}

function formatToolCallPairs(pairs: EvaluateLoopProgressParams['toolCallPairs']): string {
  return pairs
    .map((p, i) => {
      const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      return `${i + 1}. ${p.toolName}${p.args !== undefined ? ` ${JSON.stringify(p.args)}` : ''}\n   -> ${output}`;
    })
    .join('\n');
}

function buildReflectionPrompt(
  pairs: EvaluateLoopProgressParams['toolCallPairs'],
  reason: 'stagnation' | 'streak',
): string {
  const context =
    reason === 'stagnation'
      ? 'The same tool has returned materially the same result several times in a row — a nudge to try something different did not change that.'
      : 'A long, unbroken run of tool calls has happened with no pause to check in, even though none of them obviously repeated.';

  return [
    "You are reviewing another agent's recent tool-call activity to judge whether it is actually making progress, or stuck.",
    context,
    '',
    'Recent tool calls and their results, oldest first:',
    formatToolCallPairs(pairs),
    '',
    'Answer honestly: is this converging on an answer, or has it stalled?',
    '- converging: true only if the recent calls are narrowing toward something new and useful.',
    "- summary: a short, concrete account of what's actually been confirmed or ruled out so far.",
    '- guidance: if converging, a short instruction for what to do next. Omit if not converging.',
  ].join('\n');
}

export async function evaluateLoopProgress(
  params: EvaluateLoopProgressParams,
): Promise<ReflectionResult> {
  const { reason, toolCallPairs, threadId, taskId, provider, model } = params;

  const { provider: resolvedProvider, model: resolvedModel } = params.llm
    ? { provider: provider ?? '', model: model ?? '' }
    : resolveTurnModel(provider, model);

  const turnObs = startTurnObservability({
    threadId,
    taskId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'loop-guard',
  });
  const handler = turnObs.obsHandler;

  let traceError: string | null = null;
  try {
    const llm = params.llm ?? createProvider(provider, model);
    const prompt = buildReflectionPrompt(toolCallPairs, reason);
    return await invokeStructured(
      llm,
      ReflectionResultSchema,
      prompt,
      handler,
      'loop-guard:reflect',
    );
  } catch (err) {
    // Never throw out of here — a reflection call that itself fails should
    // fail safe toward escalation (the safer default) rather than silently
    // letting an unproductive loop continue unchecked.
    logger.error('loop-reflection: reflection call failed', {
      threadId,
      taskId,
      err: serializeError(err),
    });
    traceError = err instanceof Error ? err.message : String(err);
    return {
      converging: false,
      summary: 'The progress-check itself failed, so stopping rather than continuing unchecked.',
    };
  } finally {
    await turnObs.end(traceError);
  }
}
