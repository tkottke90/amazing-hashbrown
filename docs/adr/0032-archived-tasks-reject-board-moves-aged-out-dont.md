---
status: accepted
---

# Archived tasks reject board moves; Aged-Out tasks don't

An Aged-Out Task stays fully interactive — it can be reopened or rerun directly the moment someone finds it via the Show Archived toggle, because nothing about it actually changed; it only dropped out of view. An Archived Task is different: reopen, rerun, and reschedule board-moves are rejected until it's Unarchived first. The asymmetry is deliberate — Archiving is a user's explicit decision to put a task away, and letting a stray drag silently reopen it the next time someone browses the archived view would make that decision meaningless.
