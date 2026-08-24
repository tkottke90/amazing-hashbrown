# web_fetch: Support text/markdown and text/plain — Design

**Date:** 2026-08-24
**Status:** Draft
**Related:** [Issue #62](https://github.com/tkottke90/amazing-hashbrown/issues/62)

---

## Goal

`web_fetch` should return the raw text body when a server responds with `Content-Type: text/markdown` or `text/plain`, instead of rejecting the request with an "Unsupported content type" error.

---

## Problem

`api/src/services/web-fetch.ts` only passes responses through to the parser when the content type includes `text/html` or `application/xhtml`. Everything else — including `text/markdown` and `text/plain` — is rejected before the body is even read:

```
Failed to fetch https://docs.comfy.org/tutorials/basic/text-to-image.md: Unsupported content type: text/markdown.
```

This is common on LLM-focused documentation sites and GitHub raw file URLs, which frequently serve Markdown with `Content-Type: text/markdown` or `text/plain`. These are exactly the kind of pages `web_fetch` should be useful for, so rejecting them is a poor experience.

---

## Non-goals

- Broadening the fallback to accept arbitrary `text/*` content types (e.g. `text/csv`, `text/xml`). Only `text/markdown` and `text/plain` are in scope; other unrecognized types should keep erroring as they do today.
- Content sniffing (guessing format from the body when the header is missing or ambiguous).
- Changes to `suites/web-fetch.yaml`. This is a content-type handling fix at the service layer, not a change in how the agent selects or sequences tools — no new eval scenario is needed.

---

## Design

### 1. `api/src/services/web-fetch.ts`

Widen the `WebFetchResult` `contentType` union:

```ts
contentType: 'html' | 'json' | 'markdown';
```

Add a new branch after the existing `application/json` check and before the `text/html` / `application/xhtml` guard, mirroring how JSON is already handled:

```ts
if (contentType.includes('text/markdown') || contentType.includes('text/plain')) {
  const text = await res.text();
  return { status: 'ok', url, contentType: 'markdown', text, metadata: {}, links: [], outline: [] };
}
```

Both `text/markdown` and `text/plain` map to the single `'markdown'` tag — there's no behavioral difference between them (both are raw text returned as-is), so a second union member would add a branch downstream for no real gain.

No other paths change: robots.txt handling, the JSON branch, the HTML parsing/Readability branch, and the final unsupported-type error all stay as they are today.

### 2. `api/src/agents/tools/web-fetch.tool.ts`

No structural changes. The tool already handles empty `metadata`/`links`/`outline` by conditionally omitting those `##` sections, and `result.contentType` already flows into the `toolStub` metadata for the large-content stub path — the new `'markdown'` value is just another string there.

Update the tool's `description` to mention the new behavior, so the agent's own understanding of the tool is accurate:

> "For HTML pages, returns the article body in reader mode, page title and description, up to 50 outbound links, and a heading outline (H1–H3). For JSON endpoints, returns the pretty-printed JSON. For Markdown or plain-text responses, returns the raw text."

### 3. New test: `api/src/services/web-fetch.test.ts`

No test file exists for this service today. Add one, mocking global `fetch` (no live HTTP calls), covering:

- `text/markdown` → `status: 'ok'`, `contentType: 'markdown'`, raw text returned unmodified.
- `text/plain` → same.
- `application/json` → still pretty-printed (regression check on existing behavior).
- `text/html` → still parsed via Readability, with metadata/links/outline populated (regression check).
- An unsupported type (e.g. `image/png`) → still `status: 'error'` with the "Unsupported content type" message.

---

## Error handling

No new error paths. The new branch reads the body with a bare `res.text()`, matching the existing JSON branch's approach — there's no way for this to throw beyond what `fetch`/`res.text()` already handle upstream (network errors are already caught before this point; a truncated/empty body just yields an empty or partial string, same as today).

---

## Testing

- New unit tests in `api/src/services/web-fetch.test.ts` (see above).
- No changes to `suites/web-fetch.yaml` — see Non-goals.
