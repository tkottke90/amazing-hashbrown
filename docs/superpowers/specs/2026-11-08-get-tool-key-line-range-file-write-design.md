# `get_tool_key` — Line Count, Line-Range Reads, and Workspace File Write — Design

**Date:** 2026-11-08
**Status:** Draft
**Related:** `docs/superpowers/specs/2026-09-08-get-tool-key-tool-design.md` (original tool), ADR-0039, ADR-0040 (`.hashbrown/` conventions)

---

## Goal

`get_tool_key` lets the model read back content it previously offloaded to the KV store (`api/src/services/tool-content-store.ts`) because a tool result was too large to keep inline. The problem: once the model actually needs to look at that content, it has no way to ask for less than the whole thing — so the exact context-window cost the offload was meant to avoid gets paid back in full the moment the model looks. This design adds three related, independently useful capabilities to shrink that cost:

1. Every offload stub reports the content's **line count** alongside its char count, so the model has a concrete sense of scale before deciding how much to request.
2. `get_tool_key` accepts optional **`offset`/`limit`** to read back a line-range slice of the stored content instead of the whole thing.
3. In a workspace/task context, `get_tool_key` accepts an optional **`filename`** to write the (optionally sliced) content to `.hashbrown/tool-key/` on disk instead of returning it inline, so the model can build itself a durable, re-readable reference (via `shell_exec`) without paying the KV round-trip or the context cost again.

---

## Problem

`api/src/agents/tools/tool-stub.ts`'s `toolStub()` builds the "── CONTENT OFFLOADED ──" frontmatter block every offload producer returns to the model. Today it takes a caller-supplied `frontmatter` record and a list of preview `sections` — it has no access to, and makes no claim about, the actual offloaded content's shape. Five producers call it:

- `api/src/agents/tools/web-fetch.tool.ts`
- `api/src/agents/chat-agent.ts`'s `mcpToolToLangChain`
- `api/src/agents/wiki-reference-expansion.middleware.ts`
- `api/src/agents/attachment-resolution.ts`
- `api/src/agents/summary-boundary.ts`

Each one hand-computes a `chars` field for the frontmatter from whatever content it happens to be offloading. Four of the five pass the exact length of the content they store; `web-fetch.tool.ts` is the one exception — it reports `chars: result.text.length` (just the article body) while actually storing `fullContent` (body + metadata + links + outline), so the number in the stub already doesn't match what `get_tool_key` would return for it today.

`api/src/agents/tools/get-tool-key.tool.ts` itself (`getToolKeyTool`) is a single plain, non-factory `tool()` bound identically everywhere `web_fetch` is bound — `STATIC_CHAT_TOOLS` in `chat-agent.ts` (shared by `buildChatAgent`, `buildWorkspaceChatAgent`, and `buildTaskAgent` in `api/src/agents/task-execution.ts`) and `wiki-ingestion-agent.ts`'s own tool list. It always returns the full stored string from `getToolContent()` — there is no way to ask for part of it, and no notion of "this call has a workspace to write into" vs. "this call doesn't."

---

## Scope

**In scope:**

- `toolStub()`'s signature changes to derive `chars`/`lines` from the real offloaded content, and all five producers are updated to the new signature.
- `get_tool_key` gains `offset`/`limit` (line-based pagination, available in every context).
- `get_tool_key` gains an optional `filename`, available only where a workspace location is bound, which writes to `<workspace>/.hashbrown/tool-key/<filename>` and returns a confirmation instead of the content.
- Splitting `getToolKeyTool` into a factory, `makeGetToolKeyTool(workspaceLocation?: string)`, producing one of two Zod schemas depending on whether a workspace is bound, and removing the old plain export from `STATIC_CHAT_TOOLS` in favor of per-builder calls (the same move already made for `shell_exec`).
- Unit test coverage for all of the above, plus new `suites/get-tool-key.yaml` scenarios covering the new model-facing tool-choice behavior (offset/limit vs. whole-document, filename-in-workspace vs. not).
- System-prompt updates (`WEB_FETCH_SECTION` in `api/src/agents/system-prompt.ts`) describing the new args, scoped so the `filename` guidance only reads as applicable where the tool schema actually carries it.

**Out of scope:**

- Any change to `tool-content-store.ts` itself (still non-destructive, non-TTL, in-memory).
- Any change to `wiki_create_page`'s own internal KV resolution path (`corpus:{threadId,toolKey}`) — untouched.
- Byte-range (as opposed to line-range) reads.
- Any UI surface for browsing `.hashbrown/tool-key/` contents — it's agent scratch space, read back only via `shell_exec`, same as Task Files.
- Expiring or cleaning up `.hashbrown/tool-key/` files — same lifecycle as the rest of `.hashbrown/` (gitignored at provision time per ADR-0040, otherwise left alone).

---

## Design

### 1. `toolStub()` derives `chars`/`lines` from real content

`api/src/agents/tools/tool-stub.ts` signature changes from:

```ts
export function toolStub(
  frontmatter: Record<string, string | number | boolean>,
  sections: StubSection[],
): string
```

to:

```ts
export function toolStub(
  content: string,
  frontmatter: Record<string, string | number | boolean>,
  sections: StubSection[],
): string {
  const lines = content === '' ? 0 : content.split('\n').length;
  const merged = { ...frontmatter, chars: content.length, lines };
  const parts: string[] = [OFFLOAD_HEADER, stringify(merged).trimEnd()];
  for (const section of sections) {
    parts.push(sectionHeader(section.name));
    parts.push(section.content);
  }
  return parts.join('\n');
}
```

`content` is the exact string already being (or about to be) passed to `storeToolContent`/`storeToolContentEntry` at that call site — not a preview, not a derived summary. Every caller drops its own `chars: ...` field from the `frontmatter` object it builds and passes the real content as the new first argument instead:

- `web-fetch.tool.ts`: passes `fullContent` (fixing the existing `chars` mismatch noted above as a direct consequence, not separate scope).
- `chat-agent.ts`'s `mcpToolToLangChain`: passes `text`.
- `wiki-reference-expansion.middleware.ts`: passes `full`.
- `attachment-resolution.ts`: passes `extractedText`.
- `summary-boundary.ts`: passes `originalContent`.

`chars`/`lines` now land at the end of the stringified YAML frontmatter block (object spread order) rather than near the top as today — a cosmetic reordering only; nothing reads these fields positionally.

### 2. `get_tool_key` gets `offset`/`limit`

Both the restricted and full schemas (below) share:

```ts
offset: z
  .number()
  .int()
  .min(0)
  .optional()
  .default(0)
  .describe('0-based index of the first line to return. Omit to start from the beginning.'),
limit: z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Maximum number of lines to return starting at offset. Omit to return every remaining line.'),
```

Resolution logic (in a shared internal function, see §4):

- Split the stored content on `\n` into lines.
- With `offset: 0` and no `limit` (the default, and the only shape every existing caller/test/eval uses today), return the stored content **completely unchanged** — same string, no added header — so nothing regresses.
- Otherwise, slice `lines.slice(offset, limit === undefined ? undefined : offset + limit)`, rejoin with `\n`, and prepend a one-line header: `[lines {offset}-{end} of {total} total]` (where `end` is clamped to `total`), so the model knows whether it needs to page further.
- `offset` at or past the end of the content returns the not-found-shaped message's sibling: `[No lines at offset {offset} — this content has {total} lines.]` rather than an empty string, so the model doesn't misread "nothing" as "no more content exists."

Binary (image) entries are unaffected: `binary-content-fetch.middleware.ts` intercepts any call named `get_tool_key` whose stored entry is `kind: 'binary'` before the real tool ever runs, regardless of which args were supplied — `offset`/`limit`/`filename` are simply never reached for an image stub.

### 3. Workspace-gated `filename` write

#### 3a. Two schemas, one tool name

`api/src/agents/tools/get-tool-key.tool.ts` replaces its single `getToolKeyTool` export with a factory:

```ts
export function makeGetToolKeyTool(workspaceLocation?: string) {
  const baseSchema = { threadId: ..., toolKey: ..., offset: ..., limit: ... };
  const schema = workspaceLocation
    ? z.object({ ...baseSchema, filename: FilenameSchema.optional() })
    : z.object(baseSchema);

  return tool(
    async (args) => resolveGetToolKey(args, { workspaceLocation }),
    { name: 'get_tool_key', description: /* see below */, schema },
  );
}
```

Both branches delegate to the same internal resolver (§4) — the restricted schema just structurally cannot pass `filename` through, so there's one implementation, not two.

`description` text is built once and conditionally appends a `filename` paragraph only when `workspaceLocation` is defined, so a restricted-schema agent's tool description never mentions an argument it doesn't expose.

#### 3b. Binding sites

Every current binder of `getToolKeyTool` switches to calling the factory with the right value:

| Builder | File | `workspaceLocation` passed |
|---|---|---|
| `STATIC_CHAT_TOOLS` entry removed entirely | `chat-agent.ts:329-344` | — (see below) |
| `buildChatAgent` | `chat-agent.ts:515` area | `makeGetToolKeyTool()` — always restricted, plain chat has no workspace |
| `buildWorkspaceChatAgent` | `chat-agent.ts:667` area | `makeGetToolKeyTool(workspaceContext.location)` — always full |
| `buildTaskAgent` | `task-execution.ts:825` area | `makeGetToolKeyTool(workspaceScope?.workspaceContext.location)` — full when the task has a workspace, restricted otherwise |
| `buildWikiIngestionAgent` | `wiki-ingestion-agent.ts:37` area | `makeGetToolKeyTool()` — always restricted, never has a workspace |

This is the same shape `shell_exec` already has (`makeShellExecTool(workingDirectory?, options)`, built per-builder, never in `STATIC_CHAT_TOOLS`) — `get_tool_key` makes the identical move for the same reason: its correct shape depends on something only known at agent-build time, which a module-level constant array can't express.

#### 3c. Filename handling

`FilenameSchema` rejects anything that isn't a bare filename:

```ts
const FilenameSchema = z
  .string()
  .min(1)
  .refine((f) => path.basename(f) === f, 'filename must not contain path separators or "..".')
  .describe(
    'Optional bare filename (no path separators) to write the (possibly offset/limit-sliced) content ' +
      "into this workspace's .hashbrown/tool-key/ directory instead of returning it inline. Returns a " +
      'short confirmation with the path and how much was written — read it back later with shell_exec ' +
      'instead of calling get_tool_key again for the same reference.',
  );
```

When `filename` is present and `workspaceLocation` is set:

1. Apply the same `offset`/`limit` slicing as §2 to get the content to write (full content if neither given).
2. `mkdir(path.join(workspaceLocation, '.hashbrown', 'tool-key'), { recursive: true })`.
3. `writeFile` the sliced content to `<that dir>/<filename>`, overwriting silently if it already exists (this is agent scratch space — gitignored, generated, same spirit as Task Files' own overwrite-on-rewrite).
4. Return **only** a confirmation string, e.g. `Wrote 230 lines (12,480 chars) to .hashbrown/tool-key/notes.md — read it back with shell_exec; no need to call get_tool_key again for this reference.` The content itself is never included in this return value — doing so would pay back the exact context cost this whole feature exists to avoid, on the very call meant to avoid it.
5. On a write failure (e.g. permission, disk space), catch it and return an error string (`Failed to write .hashbrown/tool-key/<filename>: <message>.`) rather than throwing — consistent with every other tool in this codebase returning error text instead of raising.

If `filename` is supplied on the restricted schema, it's a Zod validation error at the tool-call boundary — this can only happen if the model hallucinates an argument that was never in its own tool definition, which `createAgent`'s existing tool-call validation already handles for every other tool.

### 4. Shared resolver

```ts
interface GetToolKeyArgs {
  threadId: string;
  toolKey: string;
  offset: number;
  limit?: number;
  filename?: string;
}

async function resolveGetToolKey(
  args: GetToolKeyArgs,
  ctx: { workspaceLocation?: string },
): Promise<string> {
  const stored = getToolContent(args.threadId, args.toolKey);
  if (!stored) return NOT_FOUND_MESSAGE(args.threadId, args.toolKey); // unchanged today's text

  const sliced = sliceLines(stored, args.offset, args.limit); // §2 logic, pure + unit-testable alone

  if (args.filename && ctx.workspaceLocation) {
    return writeToolKeyFile(ctx.workspaceLocation, args.filename, sliced);
  }

  return sliced;
}
```

`sliceLines` and `writeToolKeyFile` are both separately exported and separately unit-tested — composition over one monolithic branch-per-combination function, matching this repo's stated design principle.

### 5. System-prompt updates

`WEB_FETCH_SECTION` in `api/src/agents/system-prompt.ts` gets one new paragraph (always rendered, per this file's existing pattern of describing tools whether or not they're bound in the current agent — see `instruction-sensitivity.yaml`'s E-12/E-14 precedent) covering `offset`/`limit`: when the stub's `lines` count is large and the model only needs part of it, prefer a slice over the whole document. A second, separate short paragraph covers `filename`, phrased so it reads sensibly to a model whose own tool schema doesn't include it (it simply won't have the argument to use, the same way `schedule_wakeup` guidance in this file already tolerates not being bound everywhere it's described).

---

## Testing

- **`tool-stub.test.ts`** (new): char/line derivation for empty content, single-line content, multi-line content, and content with trailing newlines; confirms `frontmatter`'s own fields still appear, with `chars`/`lines` always present regardless of what the caller passed.
- **`get-tool-key.tool.test.ts`** (updated): existing hit/miss/non-destructive-read cases stay as-is (default `offset: 0`, no `limit` ⇒ unchanged output); new cases for `offset`/`limit` slicing (mid-document, past-end, `limit` exceeding remaining lines), `filename` writing to a temp directory standing in for `workspaceLocation` (overwrite behavior, path-separator/`..` rejection, write-failure handling), and confirmation that the restricted-schema tool's Zod schema has no `filename` key at all (not just "doesn't document it").
- **Producer tests** (`web-fetch.tool.test.ts`, `chat-agent.test.ts`, `wiki-reference-expansion.middleware.test.ts`, `attachment-resolution.test.ts`, `summary-boundary.test.ts`): updated for `toolStub()`'s new signature; assert the stub's `lines` field matches the real stored content for each, including confirming `web-fetch.tool.ts`'s existing `chars`-vs-stored mismatch is gone.
- **`suites/get-tool-key.yaml`** (new scenarios, per this repo's EDD rules — this is new model-facing tool-choice/arg behavior):
  - A scenario seeding a large stub and asking a question answerable from a known section of it, asserting the model calls `get_tool_key` with `offset`/`limit` narrowing to roughly that section rather than requesting the whole document.
  - A scenario in a workspace context asking the model to "keep a reference to this for later without spending more context on it right now," asserting `filename` is passed.
  - A scenario confirming default behavior (no `offset`/`limit`/`filename`) is unchanged when the model just wants the whole thing, guarding against regressing the existing GTK-001/002/003/004 scenarios from the original design.

I can't run `npm run eval` myself (no network path to the local model providers these suites target) — once the new scenarios are written, I'll hand off with: `npm run eval -- --suite get-tool-key --model ollama --judge-model ollama`.

## Evaluations

Covered above — required, not optional, per this repo's EDD rules (new model-facing argument/tool-choice behavior on an existing tool, not purely internal wiring).
