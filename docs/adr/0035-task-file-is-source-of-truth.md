# Task File state lives in the file itself, not the database

PR #306's `task_progress_entries` is a database table rather than a file because *concurrent sibling Tasks* writing to a shared tracker-linked resource need SQLite's transactional guarantees. A Task File has no equivalent hazard — it's written only by that one Task's own serialized Runs — so its Task State (Task Goal, Previous Tasks, Task Notes, Task Outcome, Handoff Notes) is persisted solely in the file's own YAML frontmatter. The database holds only a path pointer (`Task.taskFilePath`), never a content copy, so there is exactly one place this data can drift from.

## Considered Options

- Mirror `task_progress_entries`'s approach: persist Task State in new DB columns/tables, with the Task File generated as a read-only projection. Rejected — it doubles the write path for data that has no concurrency problem to solve, and makes the file a cache that can go stale instead of the record itself.

## Consequences

A missing or corrupt Task File means a genuine loss of that Task's history, not just a cache miss — the implementation spec covers how a rebuilt file records that gap rather than hiding it.
