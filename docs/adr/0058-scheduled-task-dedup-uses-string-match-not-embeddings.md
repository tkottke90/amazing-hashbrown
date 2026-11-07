---
status: accepted
---

# Scheduled task dedup compares normalized strings, not embeddings

De-duplicating `cron_once`/`cron_repeat` task creation (Issue #365) needs a
"close enough" check on a task's Duplicate Signature, and this app already
has an optional, provider-backed embeddings adapter
(`services/rlm-embedding-adapter.ts`) used for wiki semantic search that
could in principle catch reworded duplicates. We chose a plain
case-insensitive, whitespace-collapsed string comparison instead, because
`createTask`/`createTasks` in `services/workspace-store.ts` are synchronous
today; plugging in embeddings would force them — and every caller, the REST
route and the `create_tasks` tool — async, would make the check unavailable
whenever no embedding provider is configured, and would make matching
non-deterministic across model versions. All three conflict with this app's
testing conventions (no live external calls in developer tests) and with the
cheap, deterministic, config-driven precedent set by the Sidebar/Done-lane
retention windows. True paraphrase detection is an explicit non-goal here —
a reasonable candidate for its own follow-up issue if it turns out to matter
in practice.
