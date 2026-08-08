---
title: Wiki Raw Source Files
---

## Wiki Raw Source Files

When the agent ingests external content — a web page, a document, a conversation summary, or an uploaded file — it saves an immutable copy in the `raw/` subdirectory of the wiki domain before generating any wiki pages from it.

### Why Raw Files Exist

Raw files create a traceable chain from each final wiki page back to its original source material. They also enable drift detection: if the source content changes later, the wiki can detect the mismatch and flag it for review.

### Provenance Frontmatter

Every raw file has a YAML frontmatter block with provenance metadata:

```yaml
---
source_url: https://example.com/article
ingested: 2025-11-14
sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
---
```

- `source_url` — where the content came from (URL, file path, or conversation reference)
- `ingested` — the date the file was saved to the wiki
- `sha256` — a content hash of the raw file at ingestion time

### Drift Detection

The `source_drift` lint check (see [[Wiki Lint]]) compares the current SHA256 of each raw file against the stored hash. If they differ — because the source file was updated or re-downloaded — the check flags it as a warning.

To acknowledge the update and rebaseline the raw file, ask the agent: "Rebaseline the raw file for the DNS Server page in the homelab domain." The agent calls `wiki_rebaseline_source`, updates the SHA256, and optionally regenerates the wiki page from the new content.

### How Pages Reference Raw Files

Wiki pages that were generated from a raw source list it in their `sources` frontmatter field:

```yaml
sources:
  - raw/article-on-dns.md
```

This makes it easy to trace any fact on a wiki page back to its origin, and to find which pages would be affected if a raw source changes.

### What Gets Saved as Raw Files

- Web pages fetched during ingestion
- Documents uploaded through the wiki upload widget (see [[How to Bulk-Import Documents into the Wiki]])
- Conversation summaries produced by the AfterAgent pipeline
- Any external text content the agent is asked to ingest

### Related Pages

- [[Wiki Lint]]
- [[AfterAgent and the Knowledge Base]]
- [[How to Bulk-Import Documents into the Wiki]]
- [[Wiki Domains]]
