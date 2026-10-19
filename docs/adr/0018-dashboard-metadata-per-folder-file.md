# Dashboard Metadata stored as a per-folder file, not a central index

A Dashboard's Name, Description, and Density persist in a small metadata file inside that Dashboard's own subfolder — the same per-resource-folder pattern Widgets already use for their own Frontmatter — rather than in a single central index/registry file listing every Dashboard. This keeps one Dashboard's data (and failure modes — a corrupt file, a manual edit) isolated to its own folder, consistent with how deleting a Dashboard is just deleting its folder.

## Considered Options

- A single `dashboards.json` index at `dashboardRoot` listing every Dashboard's metadata — rejected: introduces a second storage shape alongside the per-folder pattern every other dashboard/widget resource already follows, and turns every Dashboard Metadata write into a read-modify-write of one shared file instead of touching only the Dashboard being changed.
