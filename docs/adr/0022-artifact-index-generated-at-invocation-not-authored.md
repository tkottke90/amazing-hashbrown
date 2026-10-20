# The artifact index is generated at invocation time, never authored into SKILL.md

A skill body telling the agent "run scripts/check.py" in prose is unreliable — the author has to phrase the exact tool-call shape correctly, and nothing keeps it in sync as scripts/references change. Instead, `skill-expansion.middleware.ts` appends a computed list of every current Skill Artifact, each paired with its exact `read_skill_reference`/`run_skill_script` call, on every invocation — nothing is ever written back to `SKILL.md`, so the index can't drift from disk and the artifact-authoring tools need no changes.

## Considered Options

- Generating and writing the call-out text into `SKILL.md` when an artifact is created or edited — rejected: risks drifting out of sync with manual body edits, and complicates `create_skill_artifact`/`update_skill_artifact` for a problem the live-computed approach solves without touching them.
