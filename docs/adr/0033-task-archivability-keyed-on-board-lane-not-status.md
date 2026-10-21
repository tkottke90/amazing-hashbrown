---
status: accepted
---

# Task archivability keyed on Board Lane, not literal status

The board's Done lane isn't exactly `status ∈ {done, cancelled}` — a repeating cron task whose schedule has fully exhausted also lands there while its `status` is still `pending` (see `board-rules.ts`'s `isScheduleFinished`). Archiving and the Done Lane Retention Window key off the same Board Lane computation (`board.lane === 'done'`) the UI already uses, rather than a separate literal-status check, so "what's archivable" never drifts out of sync with "what's visually in the Done lane" — including for any future status this project adds that also happens to land there.
