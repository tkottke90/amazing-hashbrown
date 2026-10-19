# Migrated `default` Dashboard keeps its literal id

The pre-existing single Dashboard (id `default`) is migrated in place rather than reassigned a fresh nanoid id like every Dashboard created after this feature. It keeps the literal id `default` — only its Dashboard Name changes, to "Default" — so the boot-time seed step and the agent tool's existing `dashboardId ?? 'default'` fallback keep working unmodified. After migration it is an ordinary Dashboard like any other: renameable, and deletable once a second Dashboard exists.

## Considered Options

- Reassigning it a fresh nanoid id on migration, for consistency with every other Dashboard — rejected: breaks the agent tool's hardcoded fallback and the boot-time seed call for no user-facing benefit, the same reasoning ADR-0009 used to avoid a migration script for Widget Size.
