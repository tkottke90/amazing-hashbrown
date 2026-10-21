---
status: accepted
---

# Sidebar retention window defaults to 7 days, not disabled

Every other optional section added to `config.yaml` in this app defaults to "no behavior change" (e.g. `updates.checkForUpdates: false`) — new config is opt-in by convention. `chat.sidebarRetentionDays` deliberately breaks that convention: it defaults to `7` rather than `0`/disabled. Shipping it disabled would mean the feature doesn't address the complaint that motivated it (a noisy sidebar) until a user discovers and opts into the setting themselves. The trade-off is a real, silent behavior change for existing installs on upgrade — threads untouched for a week stop appearing in the sidebar with no action taken — accepted because the data is never deleted (just filtered from one list) and the Threads page always shows everything regardless.
