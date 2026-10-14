# `wiki_add_cross_link` cross-wiki `fromPage` fix

Fixes [#298](https://github.com/tkottke90/amazing-hashbrown/issues/298).

## Problem

`wiki_add_cross_link({ wikiId, fromPage, toPage })` resolves `fromPage`
strictly inside the wiki named by `wikiId` — there is no way to pass a
`fromPage` that lives in a different wiki than `wikiId`. `toPage` _does_
support a `<wiki-id>:<path>` prefix for referencing a page in another wiki
(documented in its own schema description), but that only "works" because
`toPage` is never read from disk at all — it's written into the link text
unchanged.

In a real conversation (see #298), the agent created a page in the `user`
wiki and tried to cross-link it to an existing page in the `health-fitness`
wiki. Its first call omitted a prefix on `fromPage` (nothing in the schema
suggested one was needed there) and the tool threw
`addCrossLink: page not found: entities/acromioclavicular-joint-injury.md`.
That exception was never caught inside `wiki-add-cross-link.tool.ts` and
propagated all the way up through the agent's stream handler, aborting the
entire turn — so the agent's second, correctly-prefixed call never even ran.

## Goals

- `fromPage` supports the same `<wiki-id>:<path>` prefix syntax `toPage`
  already does, resolved against the actual wiki it names.
- A genuinely missing page returns a clear, recoverable tool message instead
  of throwing — this tool must never throw out of its handler.
- The existing write-scope and archive guards are checked against whichever
  wiki the write will actually land in, not the nominal `wikiId` argument
  (closes a scope-bypass gap that cross-wiki `fromPage` would otherwise open).

## Non-goals

- No change to the agent's general tool-execution/turn-abort behavior
  (`stream-handler.ts`). This fix makes `wiki_add_cross_link` itself never
  throw, which fully resolves the incident; a systemic tool-error boundary
  for the agent loop is a separate, larger discussion and is left for a
  future issue if it's ever needed again.
- No change to `toPage`'s existing (already correct, already tested)
  behavior.
- No validation that `toPage` actually exists — unchanged from today.

## Design

### Components touched

1. **`lib/llm-wiki/src/index.ts`** — publicly export `parseExternalRef` (and
   its return type) from `./internal/wikilinks.js`. It already exists, is
   already unit-tested (`wikilinks.test.ts`), and already implements exactly
   the `<wiki-id>:<path>` parsing this fix needs — it's just not currently
   reachable from `api/`. This is a visibility change only, no new logic.
2. **`api/src/agents/tools/wiki-add-cross-link.tool.ts`** — the actual fix
   (below). `lib/llm-wiki/src/llm-wiki.ts` and `wikilinks.ts` are not
   otherwise modified; `LlmWiki.addCrossLink`'s own behavior (read `fromPage`
   relative to `this` wiki, throw on missing page) is unchanged — the tool
   now simply chooses the right `LlmWiki` instance to call it on.
3. **`api/src/agents/tools/wiki-add-cross-link.tool.test.ts`** — new cases
   (below).

### Data flow

Replace the handler's current `reg.load(wikiId)` step and the subsequent
scope/archive checks and `wiki.addCrossLink(...)` call with:

```ts
const parsed = parseExternalRef(fromPage);
const targetWikiId = parsed?.wikiId ?? wikiId;
const targetFromPage = parsed?.pagePath ?? fromPage;

let wiki;
try {
  wiki = await reg.load(targetWikiId);
} catch {
  return `Wiki "${targetWikiId}" is not registered. Use wiki_locate to find available domains.`;
}

const scope = resolveToolWriteScope(config, { workspaceStore: store, threadStore });
const forbidden = scope && scopeDenial(scope, targetWikiId);
if (forbidden) return wikiWriteDeniedMessage(forbidden);
if (isWikiDomainArchived(targetWikiId, store ?? getWorkspaceStore())) {
  return wikiArchivedMessage(targetWikiId);
}

try {
  const result = await wiki.addCrossLink({ fromPage: targetFromPage, toPage });
  const warnings = result.warnings.map((w) => w.message).join(' ');
  if (warnings.includes('already present')) {
    return `Cross-link from ${fromPage} to ${toPage} already exists.`;
  }
  return `Added cross-link from ${fromPage} to ${toPage}.${warnings ? ` ${warnings}` : ''}`;
} catch {
  return (
    `Page "${targetFromPage}" not found in wiki "${targetWikiId}". If it lives in a ` +
    `different wiki, prefix fromPage with "<wiki-id>:" (e.g. "other-wiki:entities/foo.md").`
  );
}
```

Notes:

- `targetWikiId`/`targetFromPage` (the resolved values) drive loading, the
  write-scope check, the archive check, and the actual write. `fromPage`
  and `toPage` (the original, possibly-prefixed strings the model passed)
  are only used for the echoed success/already-exists messages, unchanged
  from today.
- When `fromPage` has no prefix, `targetWikiId === wikiId` and
  `targetFromPage === fromPage` — behavior is byte-for-byte identical to
  today for the common case.
- The catch around `wiki.addCrossLink(...)` is deliberately broad (matching
  the broad catches already a few lines above it in this same function)
  rather than matching the specific "page not found" string — that's
  currently the only way this call can fail, so any failure maps to the
  same message.

### Schema description updates

`wikiId` and `fromPage`'s descriptions currently say nothing about
cross-wiki references — only `toPage`'s does, which is why the model in the
original incident prefixed `toPage` but not `fromPage`. Update:

```ts
wikiId: z.string().describe(
  "Default wiki domain ID for fromPage and toPage when they don't carry their own wiki prefix.",
),
fromPage: z.string().describe(
  'Path of the page to add the link from, relative to its wiki root. ' +
    "To reference a page in a DIFFERENT wiki than wikiId, prefix with that wiki's id " +
    "and a colon, e.g. 'other-wiki-id:entities/foo' — use wiki_locate to find valid wiki ids.",
),
// toPage: unchanged
```

## Testing

New cases in `wiki-add-cross-link.tool.test.ts` (Mocha/Chai, wired to a real
`WikiRegistry` against a temp dir, matching the existing file's style):

1. **Happy path, cross-wiki `fromPage`** — `fromPage: "health-fitness:entities/foo.md"`,
   `wikiId: "user"`, page exists in `health-fitness` → link is written into
   `health-fitness`'s copy of the page; success message returned.
2. **Not-found, resolved wiki** — same shape, page doesn't exist in the
   prefixed wiki → the new graceful message naming the _resolved_ wiki;
   `tool.invoke(...)` resolves rather than rejects.
3. **Unregistered resolved wiki** — `fromPage: "bogus-wiki:entities/foo.md"`
   → `Wiki "bogus-wiki" is not registered...`, proving resolution happens
   before the registration check.
4. **Write-scope denial follows the resolved wiki** — scope locked to
   `"test-wiki"`, call passes `wikiId: "test-wiki"` but
   `fromPage: "other-wiki:entities/foo.md"` → denied, citing `"other-wiki"`.
   This is the regression test for the scope-bypass gap identified during
   design — without the fix, this case would silently succeed.
5. **Archived resolved wiki** — same idea against `isWikiDomainArchived`,
   with a prefixed `fromPage` pointing at an archived wiki.
6. **No-prefix regression** — existing plain-`fromPage` test cases keep
   passing unchanged, confirming zero behavior change for the common case.
7. **`toPage` cross-wiki passthrough** — already covered by the existing
   `'writes a wikiId:pagePath toPage through unchanged...'` test; untouched.

No new test needed in `lib/llm-wiki`: `parseExternalRef` already has full
unit coverage in `wikilinks.test.ts`, `LlmWiki.addCrossLink`'s own behavior
isn't changing, and the new export in `index.ts` is a pure re-export with no
runtime behavior (per the root `AGENTS.md` testing blacklist).
