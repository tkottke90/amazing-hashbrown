---
title: How to Bulk-Import Documents into the Wiki
---

## How to Bulk-Import Documents into the Wiki

If you have a collection of existing notes, articles, or exported data, you can import them all at once using the wiki upload feature rather than feeding them to the agent one at a time.

### Supported Archive Formats

The upload widget accepts:

- `.zip`
- `.tgz`
- `.tar.gz`
- `.tar`

Archives should contain plain markdown (`.md`) or plain text (`.txt`) files. Nested directory structures inside the archive are preserved during extraction but flattened when the agent processes the files.

Individual files can also be dragged directly into the upload widget — no archive needed for small batches.

### Step-by-Step

1. Open the Wiki view at `/wiki` in the app.
2. In the ingestion chat panel on the right side, locate the upload widget.
3. Drag your archive (or individual files) onto the widget, or click to browse and select.
4. The files are extracted into a staging area on the server.
5. In the chat, tell the ingestion agent which domain to import them into:

   > "Import these into the homelab domain."

6. The agent processes each file in sequence. For each file it will:
   - Save an immutable copy to `raw/` (see [[Wiki Raw Source Files]])
   - Generate a wiki page from the content
   - Pick the appropriate [[Wiki Page Types|page type]] and tags
   - Add the page to `index.md`

### Deduplication

The agent uses SHA256 tracking to detect files that have already been ingested. If you upload the same archive again — or an archive that overlaps with a previous upload — unchanged files are skipped automatically. Only new or modified files are processed.

### Tips for Good Import Results

- Give files descriptive names before archiving them — the filename is used as a hint for the page title.
- Include a brief header or frontmatter in your source files if you know the type and tags you want. The agent will respect them if present.
- Import into a focused domain rather than a catch-all. The more specific the domain's [[Wiki SCHEMA.md]], the better the agent tags and classifies pages.

### Related Pages

- [[Wiki Raw Source Files]]
- [[Wiki Page Types]]
- [[Wiki SCHEMA.md]]
- [[Wiki Domains]]
