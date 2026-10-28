# Self-Disabled Recurrence Lands in the Done Lane, Not Schedule Paused

When a `cron_repeat` task Disables its own Recurrence (because it determined no further runs are needed), its `ScheduleInactiveReason` joins `FINISHED_SCHEDULE`, placing it in the board's `done` lane — not `schedule_paused`, even though its underlying `TaskStatus` is `pending` (resumable), identical to the existing consecutive-failures auto-pause. `schedule_paused` already signals "something's broken, come look"; a self-disabled Recurrence is the opposite signal — the agent's work is finished — so reusing that lane would mislead anyone scanning the board, even though the state is reversible the same way a `schedule_paused` task's is.

**Considered**: Reusing `schedule_paused`, since the underlying plumbing (`pending` status + a `pausedReason`) is identical to consecutive-failures. Rejected because the lane's established meaning to a human skimming the board is "needs attention," not "stopped itself on purpose."
