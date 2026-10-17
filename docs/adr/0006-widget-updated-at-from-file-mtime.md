# Widget "last updated" is derived from file mtime, not a persisted field

The #176 mockup shows an "updated Xm ago" footer per widget. Every widget write already touches its file on disk, so the file's own `mtime` is already an accurate "last updated" timestamp — reading it at list/load time costs nothing and can never drift from the file's real last-write time. We derive it this way instead of adding an `updatedAt` Widget Frontmatter field that every write path (drawer, the new content route, and any future writer) would have to remember to set correctly.

## Considered Options

- A persisted `updatedAt` frontmatter field, set explicitly by each write path — rejected: redundant with information the filesystem already tracks for free, and one more thing a future write path can forget to set.
