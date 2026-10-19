# Dashboard id is permanent and decoupled from Dashboard Name

Dashboard identity — its on-disk folder, every API path, every agent-tool reference — is carried by a Dashboard Id, assigned once at creation and never changed. Renaming a Dashboard only updates its Dashboard Metadata, never touches the folder. New Dashboard ids are generated via `node:crypto`'s `randomUUID()` rather than derived from the Dashboard Name, because Dashboard Names are explicitly not unique (two Dashboards may share a display name), and a name-derived slug would need its own collision handling for no benefit once id and name are kept independent regardless. `randomUUID()` matches this codebase's existing id-generation pattern (`lib/amazing-hashbrown-widgets/src/internal/slug.ts`'s collision suffix already uses it) rather than adding a new dependency (e.g. nanoid) for no behavioral difference.

## Considered Options

- Slug-derived ids (what the UI design mockup prototyped) — rejected: only works cleanly when names are unique, which Dashboard Names deliberately aren't.
- Letting rename move/rename the on-disk folder to match the new name — rejected: couples a cheap metadata edit to a filesystem operation, and anything holding a stale path (an open agent tool call, a cached reference) breaks on every rename.
