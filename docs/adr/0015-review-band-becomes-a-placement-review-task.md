# Review Band writes become a Placement Review Task, not a new review mechanism

A mid-confidence (Review Band, Domain Fit Score 5–7) AfterAgent extraction needs a human decision before it can commit, but AfterAgent runs as a detached background pipeline with no live turn to pause — there's no user on the other end of an `ask_user` call at the moment `extract` finishes. We considered building a dedicated review-queue surface (a new table, a new UI list, a new approve/reject endpoint) but rejected it: the codebase already has a mechanism for exactly this shape of problem — a self-contained, queued unit of work that runs later and can pause on `ask_user` mid-run — namely tasks (`assignedTo: 'agent'`, `task_queue`, HITL). AfterAgent instead creates a Placement Review Task carrying everything `extract` produced, and the decision (and the eventual write, if any) happens inside that task's own run, through the ordinary `wiki_create_page`/`wiki_update_page` tools and the same Write Scope check a live chat turn already goes through.

## Considered Options

- A dedicated review-queue table/UI/endpoint — rejected: duplicates the task system's existing queued-unit-of-work-with-HITL shape for no added benefit, and would need its own board/list surface the Kanban board already provides for tasks.
- Having AfterAgent itself pick a domain and write immediately, flagging the page for later human correction — rejected: writes a wrong page that must then be found and fixed, which is the exact failure mode #333 reported; better not to write at all until a human has actually chosen.
