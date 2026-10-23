# Raising a type's Widget Size minimum clamps pre-existing too-small values at parse time, not just missing ones

ADR-0009 established that a widget file predating `w`/`h` reads as its type's minimum, applied in `parseWidgetFile` before `WidgetFrontmatterSchema.safeParse` runs — because the schema's `.min(WIDGET_SIZE_MIN[type].w)` would otherwise reject a file with no `w` at all. Raising an existing type's minimum (as the Pie Graph widget's legend needs) creates the same problem for a different reason: pre-existing files that *do* have an explicit `w`/`h`, set under the old, smaller minimum, now fail that same `.min()` check instead of just defaulting past it. We're extending the ADR-0009 default to also clamp an explicit value up to the new minimum when it falls below it, rather than only filling in a missing one — so a type's minimum can be raised in place, with no migration step and no widget file ever failing to load because of it.

## Considered Options

- A migration script rewriting every existing Pie Graph widget file's `w`/`h` up to the new minimum on deploy — rejected for the same reason ADR-0009 rejected one for the missing-field case: one more deploy step that can fail, for a result identical to clamping at read time.
