import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';

// Keep this in sync with suites/hand-off-guidance.yaml's scenario `input`
// field — the eval suite tests this exact prompt template.
function buildPrompt(input: HandOffGuidanceInput): string {
  return [
    `Current title: ${input.title}`,
    `Current description: ${input.description ?? '(none)'}`,
    `Why this got stuck (Hand-Off Note): ${input.handOffNote ?? '(none recorded)'}`,
    `Human guidance for how to proceed: ${input.guidance}`,
    'Rewrite the title and description so a fresh attempt at this task incorporates the ' +
      'guidance above and avoids repeating what got it stuck. Respond with ONLY a JSON ' +
      'object: {"title": "...", "description": "..."} — no markdown, no preamble.',
  ].join('\n\n');
}

export interface HandOffGuidanceInput {
  title: string;
  description: string | null;
  // The Handed-Off Run's own summary (task_queue.summary) — see GLOSSARY.md
  // § Hand-Off Note.
  handOffNote: string | null;
  // The human's free-text Hand-Off Guidance.
  guidance: string;
}

export interface RewrittenTask {
  title: string;
  description: string | null;
}

function parseRewrite(raw: string): RewrittenTask {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Rewrite produced unparseable output (not valid JSON).');
  }

  const { title, description } = (parsed ?? {}) as { title?: unknown; description?: unknown };
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('Rewrite produced no usable title.');
  }
  return { title, description: typeof description === 'string' ? description : null };
}

// Folds a human's Hand-Off Guidance together with the Hand-Off Note into a
// rewritten title/description — a single plain, non-agentic model.invoke(),
// no tool harness, modeled on plan-generation.ts's runPathA(). Deliberately
// THROWS on failure, unlike every other one-shot call in agents/ (e.g.
// exhausted-run-summarizer.ts's summarizeExhaustedRun): per ADR-0057, a
// failed rewrite must surface an error to the human rather than silently
// leaving the Task unchanged or falling back to raw guidance text.
export async function rewriteTaskForHandOffGuidance(
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  input: HandOffGuidanceInput,
): Promise<RewrittenTask> {
  const prompt = buildPrompt(input);

  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    provider,
    modelName,
  );
  const turnObs = startTurnObservability({
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'hand-off-guidance',
    systemPrompt: prompt,
  });

  let error: string | null = null;
  try {
    const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
    const raw =
      typeof response.content === 'string' ? response.content : String(response.content ?? '');
    return parseRewrite(raw);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err instanceof Error ? err : new Error(error);
  } finally {
    await turnObs.end(error);
  }
}
