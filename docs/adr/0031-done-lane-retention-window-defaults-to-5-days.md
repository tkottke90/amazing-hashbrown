---
status: accepted
---

# Done Lane Retention Window defaults to 5 days, not disabled

Mirrors ADR-0030's reasoning for the near-identical thread Sidebar Retention Window: shipping `tasks.doneRetentionDays` disabled (the usual opt-in-by-default convention for new config in this app) would mean the feature does nothing until a user finds and enables it, leaving the exact clutter problem it was built for unaddressed on day one. Defaults to `5` instead — shorter than chat's 7, since a Done task is a closed record rather than something still being referenced day-to-day. Accepted as a real, silent behavior change for existing installs on upgrade, because no data is ever deleted — a Done task just stops appearing in the board's Done lane and the Inbox until it's touched again or revealed via the Show Archived toggle, which always shows everything regardless of age.
