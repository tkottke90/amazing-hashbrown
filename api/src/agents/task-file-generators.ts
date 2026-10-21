import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { buildTaskDescriptionBlock } from './plan-generation.js';
import { formatPlanChecklist, type TaskContext } from './task-context.js';
import type { TaskState } from '../services/task-file.js';
import { logger, serializeError } from '../config/logger.js';

// Two standalone, one-off LLM calls a Task File's pre-run/post-run steps
// make outside the main task agent loop — structural siblings of
// plan-generation.ts's runPathA (an already-constructed model, passed in by
// the caller, rather than built here), but unlike runPathA they never
// rethrow: a missing Task Goal or Handoff Notes is a lesser artifact, not a
// reason to fail a task run (see
// docs/superpowers/specs/2026-10-21-workspace-task-files-design.md §7).

function buildTaskContextLines(task: TaskContext): string[] {
  const lines = [buildTaskDescriptionBlock(task.title, task.description)];
  if (task.outcome) lines.push(`Outcome to reach: ${task.outcome}`);
  if (task.plan && task.plan.length > 0) lines.push(`Plan:\n${formatPlanChecklist(task.plan)}`);
  return lines;
}

export interface TaskGoalInput {
  task: TaskContext;
  previousTasks: string[];
}

// Reads title/description/outcome/plan plus the Previous Tasks list, and
// returns a short first-person restatement of what the task is trying to
// do. Regenerated at the start of every run and overwritten in place — see
// GLOSSARY.md § Task Files, "Task Goal".
export async function generateTaskGoal(
  model: BaseChatModel,
  provider: string,
  modelName: string,
  input: TaskGoalInput,
): Promise<string> {
  const sections = buildTaskContextLines(input.task);
  if (input.previousTasks.length > 0) {
    sections.push(
      `Other tasks already done in this workspace:\n${input.previousTasks.map((t) => `- ${t}`).join('\n')}`,
    );
  }
  sections.push(
    'In one or two sentences, restate in your own words what this task is trying to ' +
      'accomplish. Respond with ONLY that restatement — no preamble, no markdown.',
  );
  const prompt = sections.join('\n\n');

  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    provider,
    modelName,
  );
  const turnObs = startTurnObservability({
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'task-file-goal',
    systemPrompt: prompt,
  });

  let error: string | null = null;
  try {
    const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
    const content = response.content;
    return (typeof content === 'string' ? content : String(content ?? '')).trim();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn('task-file-generators: generateTaskGoal failed, leaving Task Goal empty', {
      err: serializeError(err),
    });
    return '';
  } finally {
    await turnObs.end(error);
  }
}

export interface HandoffNotesInput {
  task: TaskContext;
  state: TaskState;
}

// Reads the same task fields plus this run's just-decided outcome and
// every run's accumulated notes, and returns a note to whoever picks this
// task up next. A genuinely new call, distinct from Task Outcome (which
// reuses the run's own ending summary rather than asking the model again)
// — see ADR-0036 and GLOSSARY.md § Task Files, "Handoff Notes".
export async function generateHandoffNotes(
  model: BaseChatModel,
  provider: string,
  modelName: string,
  input: HandoffNotesInput,
): Promise<string> {
  const sections = buildTaskContextLines(input.task);
  sections.push(`This run's outcome: ${input.state.outcome}`);
  const allNotes = input.state.notes.flat();
  if (allNotes.length > 0) {
    sections.push(
      `Notes recorded across every run so far:\n${allNotes.map((n) => `- ${n}`).join('\n')}`,
    );
  }
  sections.push(
    'Write a short handoff note for whoever picks this task up next — what they should ' +
      'know or follow up on. Respond with ONLY that note — no preamble, no markdown.',
  );
  const prompt = sections.join('\n\n');

  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    provider,
    modelName,
  );
  const turnObs = startTurnObservability({
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'task-file-handoff',
    systemPrompt: prompt,
  });

  let error: string | null = null;
  try {
    const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
    const content = response.content;
    return (typeof content === 'string' ? content : String(content ?? '')).trim();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn('task-file-generators: generateHandoffNotes failed, leaving Handoff Notes empty', {
      err: serializeError(err),
    });
    return '';
  } finally {
    await turnObs.end(error);
  }
}
