import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger, serializeError } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { getWorkspaceStore, TASK_TITLE_MAX_LENGTH } from '../services/workspace-store.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';

// Keep this in sync with suites/sub-agent-task-titles.yaml's scenario
// `input` field — the eval suite tests this exact prompt template.
function buildPrompt(goal: string): string {
  return (
    `Summarize the following task instruction as a short, specific title ` +
    `(no more than ${TASK_TITLE_MAX_LENGTH} characters). Do not use quotation marks ` +
    `or end with punctuation. Respond with only the title, nothing else.\n\n` +
    `Instruction:\n${goal}`
  );
}

function parseTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const trimmed = text
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
  if (!trimmed) throw new Error('Title generation produced an empty result.');
  // Defensive — never trust the model to actually respect the prompt's
  // length instruction.
  return trimmed.length > TASK_TITLE_MAX_LENGTH ? trimmed.slice(0, TASK_TITLE_MAX_LENGTH) : trimmed;
}

// The Generated Title for a Sub-Agent Task: a single plain (non-streaming,
// non-agentic) completion over its Sub-Agent Goal — no tools, no
// checkpointer. `model` is passed in already constructed so this stays
// unit-testable with a fake BaseChatModel, matching this codebase's rule to
// always mock external services in developer tests. Throws on any failure
// — see triggerSubAgentTitleGeneration below for the caller that swallows
// it. See ADR-0059, GLOSSARY.md § Generated Title.
export async function generateSubAgentTaskTitle(
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  goal: string,
): Promise<string> {
  const prompt = buildPrompt(goal);

  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    provider,
    modelName,
  );
  const turnObs = startTurnObservability({
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'sub-agent-task-title',
    systemPrompt: prompt,
  });

  let error: string | null = null;
  try {
    const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
    return parseTitle(response.content);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err instanceof Error ? err : new Error(error);
  } finally {
    await turnObs.end(error);
  }
}

// Fires the Generated Title call for a freshly-created Sub-Agent Task and
// applies the result — entirely in the background, never throws, so a
// caller can safely fire it without awaiting (see spawn-sub-agent.tool.ts).
// On any failure — including env.defaultProvider being unconfigured, a
// createProvider() construction error, or the model call itself failing —
// the Task simply keeps the mechanical-truncation placeholder
// createSubAgentTask already gave it. A taskId that no longer exists
// (deleted/archived before generation finished) is likewise a silent
// no-op, since patchTask() returns null rather than throwing.
//
// modelOverride exists only for tests — production callers always omit it,
// letting createProvider() resolve env.defaultProvider. It's an argument
// rather than a default-parameter value specifically so createProvider()'s
// construction runs inside this function's own try block: a default value
// (`= createProvider(...)`) would evaluate — and could throw synchronously
// — before this function is even entered, which would escape the
// `.catch()` a fire-and-forget caller relies on.
export async function triggerSubAgentTitleGeneration(
  taskId: string,
  goal: string,
  modelOverride?: BaseChatModel,
): Promise<void> {
  try {
    const model = modelOverride ?? createProvider(undefined, undefined);
    const title = await generateSubAgentTaskTitle(model, undefined, undefined, goal);
    getWorkspaceStore().patchTask(taskId, { title });
  } catch (err) {
    logger.warn('sub-agent-task-title: generation failed, keeping truncated placeholder', {
      taskId,
      err: serializeError(err),
    });
  }
}
