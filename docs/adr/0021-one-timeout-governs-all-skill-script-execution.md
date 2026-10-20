# One configurable timeout governs every skill script execution path

No skill script execution had a timeout before this — including the existing `test_skill_artifact` authoring dry-run. Rather than add a timeout only to the new runtime-invocation path and leave the dry-run unbounded, a single app-config setting governs both, so "how long can a skill script run" has one answer regardless of which tool triggered it.
