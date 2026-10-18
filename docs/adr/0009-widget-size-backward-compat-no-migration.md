# Widget Size backward compatibility: parse-time default, no migration

Widget files persisted before this feature have no `w`/`h` in their frontmatter. Rather than writing a migration script that rewrites every existing widget file on deploy, a missing `w`/`h` is read as that widget's type-minimum at parse time — the same backward-compatibility pattern already used for Widget Source (a pre-existing file reads as `manual`). Old files stay untouched on disk; the default is applied purely at read time.

## Considered Options

- A migration script run once on deploy to backfill `w`/`h` onto every existing widget file — rejected: one more deploy step that can fail, for no benefit over defaulting at read time (the result is identical either way).
