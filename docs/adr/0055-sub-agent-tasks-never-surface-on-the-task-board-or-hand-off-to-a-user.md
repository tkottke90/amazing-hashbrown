# Sub-Agent Tasks never surface on the Task board or hand off to a user

Designing chat-visible monitoring for `spawn_sub_agent` dispatches (see `docs/superpowers/specs/2026-11-01-sub-agent-delegation-design.md`) raised whether a Sub-Agent Task should also get a card on the Task drawer/board, the same as any user-created Task.

We considered adding a board lane for them, since they're still `Task` rows and the board infrastructure already exists. Rejected: a Sub-Agent Task can never be handed to a human — `ask_user`, `hand_off_task`, and `complete_task` are absent from a Sub-Agent Task's Run by default (`getSubAgentToolIds()`, `api/src/agents/tool-config.ts`), and #161's own design already treats it as outside the board's "one in-progress task" accounting. Giving it a lane would offer drag/pause/hand-off affordances that don't apply to something dispatched and completed strictly agent-to-agent — a Sub-Agent Task is the parent agent's own delegate, not a unit of work the user is meant to manage directly.

Decided: a Sub-Agent Task stays reachable only through its dispatch/completion marker link in the parent thread (opening the same read-only `TaskRunView` any Task Run uses); it is never queried into the board/drawer's task list.
