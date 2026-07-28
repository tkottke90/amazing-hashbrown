# Wiki Lint Remediation Tools — Design

**Date:** 2026-07-28
**Status:** Approved
**Depends on:** Wiki Lint Tool (complete)

---

## Overview

`wiki_lint` reports 12 finding types but the agent can only act on three of them (`broken_links`, `index`, `stale`) using existing write tools. This closes the remaining gaps so every finding type has a fix path, including `source_drift` and `registry_sync` which were deferred from the original lint tool scope.

---

## Scope

All 12 check IDs from `LintCheckId`:

| Finding | Fix mechanism | New work |
|---|---|---|
| `broken_links` | `wiki_update_page` to correct wikilink targets | None — already fixable |
| `orphans` | New `wiki_add_cross_link` tool | New tool (SDK has `addCrossLink()`) |
| `index` | `wiki_update_page` on index.md | None — already fixable |
| `frontmatter` | `wiki_update_page` with corrected field values | None — already fixable |
| `page_size` | `wiki_create_page` (subpage) + `wiki_update_page` (original) | None — agent-composable with existing tools |
| `tag_audit` | `wiki_update_page` with `tags` param | Expose `tags` in tool schema |
| `source_drift` | New `wiki_rebaseline_source` tool | New SDK method + new tool |
| `log_rotation` | `wiki_create_page` (archive file) + `wiki_update_page` (trim log.md) | None — agent-composable with existing tools |
| `stale` | `wiki_update_page` with refreshed content | None — already fixable |
| `quality` | `wiki_update_page` with `confidence`/`contested` params | Add fields to service + tool schemas |
| `contradictions` | `wiki_update_page` with `contradictions` + `contested` | Same as `quality` |
| `registry_sync` | New `wiki_register_domain` tool | New SDK method + new tool + refactor `create()` |

After this item, `wiki_lint`'s description is updated to reflect the full fix coverage.

---

## Layer 1: SDK (`lib/llm-wiki/`)

### `LlmWiki.rebaselineRawSource(relPath: string): Promise<{ path: string }>`

New method. Fixes `source_drift` findings by re-establishing the raw file's sha256 baseline against its current content.

**Behavior:**
1. Reads the existing raw file at `relPath` (throws ENOENT if not found)
2. Parses frontmatter to extract the body and preserve the existing `source_url`
3. Computes sha256 of the body using the internal `sha256Body()` utility
4. Calls `saveRawSource()` with the same `path`, original `source_url`, and the freshly computed sha256

The `raw/` directory is write-once by convention, not by enforcement. Rebaselining accepts the current content as the new ground truth — it does not restore the original. The `source_url` is always carried forward from the existing frontmatter.

Throws if the raw file does not exist. No new public types or exports needed — the method is on the already-exported `LlmWiki` class.

### `WikiRegistry.register(id: string, opts?: { domain?: string; tags?: string[]; routingNotes?: string[] }): Promise<void>`

New method. Registers an already-existing on-disk wiki directory in `registry.json`. Fixes `registry_sync` findings.

**Behavior:**
1. Throws `"Wiki id already registered: ${id}"` if the id is already in `registry.json`
2. Resolves the directory path as `<wikiRoot>/<id>` (uses `id` as the relative path)
3. Validates the directory exists and contains `SCHEMA.md` — throws `"Wiki directory not found or missing SCHEMA.md: ${id}"` otherwise
4. Reads `SCHEMA.md` and extracts domain by finding the line immediately following the `## Domain` heading (falls back to empty string if the section is absent or empty)
5. Uses `opts.domain` as an override if provided, otherwise uses the parsed domain
6. Creates a `WikiEntry`: `{ id, path: id, domain, tags: opts?.tags ?? [], status: 'active' }`
7. Appends `opts.routingNotes` to `this.data.routingNotes` if provided
8. Persists via the existing `persist()` method

Registry `tags` default to empty — they serve routing/discovery in the registry and are distinct from the page taxonomy defined in `SCHEMA.md`.

### Refactor `WikiRegistry.create(input)`

After `LlmWiki.create()` scaffolds the wiki directory, delegate the registry entry creation to `this.register(input.id, { domain: input.domain, tags: input.tags, routingNotes: input.routingNotes })`. Remove the current manual `this.data.wikis.push()` + `this.persist()` block.

External behavior is identical. This is purely internal decomposition — `create()` now composes `scaffold + register` rather than duplicating the persist logic.

---

## Layer 2: Service (`api/src/services/wiki-write.ts`)

### `CreateWikiPageParams`

Add three optional fields:
- `confidence?: 'high' | 'medium' | 'low'`
- `contested?: boolean`
- `contradictions?: string[]`

Passed through to `commitPage()` unchanged. No new result variants.

### `UpdateWikiPageParams`

Add the same three optional fields. Extend the existing carry-forward pattern: when a field is omitted, the existing page's frontmatter value is preserved (same behavior as `tags` and `sources`). When provided, the new value replaces the existing one.

Carry-forward is the correct default because these are epistemological quality signals — an agent doing a routine content update should not silently clear a `confidence: 'low'` flag set by a prior assessment. An agent that has genuinely resolved the uncertainty supplies the new value explicitly.

---

## Layer 3: Tools (`api/src/agents/tools/`)

### `wiki_update_page` — schema additions

Add to `WikiUpdatePageSchema`:
- `tags` — `z.array(z.string()).optional()` — already accepted by the service, not previously exposed in the tool wrapper; fixes `tag_audit` findings
- `confidence` — `z.enum(['high', 'medium', 'low']).optional()`
- `contested` — `z.boolean().optional()`
- `contradictions` — `z.array(z.string()).optional()` — page slugs/paths this page contradicts

The handler passes all four through to `updateWikiPage()`. Carry-forward semantics are handled by the service; the tool is transparent.

### `wiki_create_page` — schema additions

Add to `WikiCreatePageSchema`:
- `confidence` — `z.enum(['high', 'medium', 'low']).optional()`
- `contested` — `z.boolean().optional()`
- `contradictions` — `z.array(z.string()).optional()`

The handler passes them through to `createWikiPage()`.

### New: `wiki_add_cross_link`

File: `api/src/agents/tools/wiki-add-cross-link.tool.ts`

**Schema:**
- `wikiId: string` — wiki domain ID
- `fromPage: string` — path of the page to add the link from
- `toPage: string` — path or slug of the page to link to

**Behavior:** Loads the wiki via the registry, calls `wiki.addCrossLink({ fromPage, toPage })`. The SDK inserts `[[targetStem]]` under a `## Related Pages` section (creating the section if absent). The `missing-related` warning ("cross-link already present") is surfaced as an informational message — the end state is already correct. Other errors propagate normally.

**Use case:** Fixes `orphans` findings where a page has no inbound links. The agent reads the orphaned page to identify a suitable link target, then calls this tool.

### New: `wiki_rebaseline_source`

File: `api/src/agents/tools/wiki-rebaseline-source.tool.ts`

**Schema:**
- `wikiId: string` — wiki domain ID
- `rawFilePath: string` — value of the `page` field from a `source_drift` lint finding (e.g. `raw/articles/some-source.md`)

**Behavior:** Loads the wiki via the registry, calls `wiki.rebaselineRawSource(rawFilePath)`. Returns a confirmation string with the file path on success. Returns a not-found message if the raw file doesn't exist (the finding's path may be stale).

**Use case:** Fixes `source_drift` findings where a raw source file's content no longer matches its stored sha256. Accepts the current content as the new baseline.

### New: `wiki_register_domain`

File: `api/src/agents/tools/wiki-register-domain.tool.ts`

**Schema:**
- `wikiId: string` — the directory name of the unregistered wiki (from the `registry_sync` finding message)
- `routingNotes: z.array(z.string()).optional()` — routing hints to append to the global registry

**Behavior:** Calls `registry.register(wikiId, { routingNotes })`. Domain is read automatically from SCHEMA.md. Returns a confirmation on success. Returns an "already registered" message if the wiki was registered concurrently, and a "not found" message if the directory doesn't exist or lacks SCHEMA.md.

**Use case:** Fixes `registry_sync` findings where an on-disk wiki directory is absent from `registry.json`.

### Tool registration

All three new tools are added to the agent's tool list alongside the existing wiki tools.

---

## Layer 4: Eval suite (`suites/wiki-lint.yaml`)

Four new scenarios added to the existing suite:

| ID | Type | Scenario |
|---|---|---|
| `wlint-003` | `tool-call` | Agent receives `source_drift` finding; must call `wiki_rebaseline_source` with correct `wikiId` and `rawFilePath` |
| `wlint-004` | `tool-call` | Agent receives `registry_sync` finding; must call `wiki_register_domain` with the directory name as `wikiId` |
| `wlint-005` | `tool-sequence` | Agent receives `orphans` finding; reads the orphaned page to identify a link target, then calls `wiki_add_cross_link` |
| `wlint-006` | `tool-call` | Agent receives `quality` finding; calls `wiki_update_page` with an appropriate `confidence` value |

`wlint-005` is a `tool-sequence` because the finding doesn't supply `toPage` — the agent must read context to determine a candidate before calling the cross-link tool.

---

## `wiki_lint` description update

After all tools ship, the `wiki_lint` tool description is updated to reflect full fix coverage: every finding type now has a documented fix path, replacing the prior note that directed the agent to say it cannot fix certain categories.
