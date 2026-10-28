import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import type { CronRepeatConfig } from '../../services/cron-config.js';
import { getCronRegistry } from '../../services/cron-registry.js';

const DisableRecurrenceSchema = z.object({});

// Built fresh per automated task run, closed over that task's id (same
// per-construction factory pattern as makeUpdatePlanTool/makeCompleteTaskTool),
// with an optionally injected store for testability. Bound only for a
// cron_repeat task (see buildTaskRecurrenceTools in chat-agent.ts) — never
// offered to a manual/chat/cron_once/webhook task.
//
// Disabling is the only effect here: the current run still ends normally
// via complete_task afterward, whose own `summary` is the durable record of
// *why* — this tool deliberately takes no reason/summary of its own. See
// docs/superpowers/specs/2026-10-28-disable-recurrence-design.md and
// GLOSSARY.md's "Cron Task Recurrence" section.
export function makeDisableRecurrenceTool(taskId: string, store?: WorkspaceStore) {
  return tool(
    async () => {
      const s = store ?? getWorkspaceStore();
      const task = s.getTask(taskId);
      // Scoped to cron_repeat specifically, not every cron trigger type —
      // CronOnceConfig has no pausedReason field to set, and a one-shot has
      // nothing left to disable once it's fired.
      if (!task || task.triggerType !== 'cron_repeat') {
        return 'Cannot disable recurrence: this is not a recurring task.';
      }

      const config = task.triggerConfig as CronRepeatConfig | null;
      if (!config) return 'Cannot disable recurrence: this task has no schedule configured.';

      // Already off — whether from a human's manual pause, an earlier
      // consecutive-failures auto-pause, or an earlier call to this same
      // tool. Never overwrite an existing pausedReason.
      if (!config.enabled) return 'Recurrence is already off.';

      s.patchTask(taskId, {
        triggerConfig: { ...config, enabled: false, pausedReason: 'no_further_runs_needed' },
      });
      getCronRegistry().sync(taskId);

      return 'Recurrence disabled — this task will not fire again until it is re-enabled.';
    },
    {
      name: 'disable_recurrence',
      description:
        "Stop this recurring task's own future runs because you have determined no further runs " +
        'are needed. The current run still ends normally — call complete_task afterward as usual. ' +
        'A human can re-enable the schedule later if this turns out to be wrong.',
      schema: DisableRecurrenceSchema,
    },
  );
}
