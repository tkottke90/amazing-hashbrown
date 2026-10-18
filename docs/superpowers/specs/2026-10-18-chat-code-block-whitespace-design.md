# Chat Code Block Whitespace Preservation — Design

**Date:** 2026-10-18
**Status:** Draft
**Related:** `ui/src/components/markdown.tsx` (the `Markdown`/`CodeBlock`
components this spec changes), `ui/src/pages/settings/agent-behavior-panel.tsx`
(the settings page this spec extends)

---

## Goal

Fenced code blocks rendered anywhere `<Markdown>` is used (chat, wiki,
dashboard widgets, workspace chat) currently lose their indentation on
screen, and copying a block's contents copies the same collapsed
whitespace — which silently breaks whitespace-sensitive formats like YAML
when pasted elsewhere. Fix the underlying whitespace handling so both
rendering and copy preserve a code block's exact formatting, and give the
user a global setting to choose how an overly long line is handled once
exact whitespace is no longer being collapsed to force a wrap.

## Problem

`CodeBlock` (`ui/src/components/markdown.tsx:41`) renders the `<pre>` with
Tailwind's `whitespace-pre-line`:

```tsx
className={cn('overflow-hidden whitespace-pre-line', props.className)}
```

`white-space: pre-line` collapses runs of spaces/tabs down to a single
space and only preserves line *breaks* — it does not preserve the
whitespace *within* a line. A native `<pre>` element's default
(`white-space: pre`) already preserves both; this class is actively
overriding that default, which is what collapses indentation visually.

The block's Copy button (same file) reads `ref.current?.innerText`.
`innerText` reflects the element's CSS-rendered whitespace, not its raw
text content, so the collapsed indentation is also what gets copied to the
clipboard — breaking formats like YAML that depend on leading whitespace
for structure.

Removing `whitespace-pre-line` outright also removes the only thing that
was making long lines wrap instead of overflowing horizontally, so the fix
needs an explicit replacement for that behavior, not just a deletion.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                    | Rationale                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Both long-line handling modes (scroll and wrap) fully preserve whitespace. Neither mode brings back `whitespace-pre-line`.                                                      | The bug is "whitespace gets collapsed," not "the wrong long-line behavior is chosen." Any fix that keeps `pre-line` in either mode would leave the reported bug in place half the time.                      |
| D2  | Scroll (`whitespace-pre` + horizontal scroll) is the default, unconfigured behavior.                                                                                           | Matches GitHub/VS Code-style code block conventions this app's syntax theme already follows, and is the safer default for copy/paste-sensitive content like YAML — nothing is ever reflowed.                  |
| D3  | The scroll/wrap choice is a new user-controlled global setting (`chat.codeBlockWrap`, default `false`), not a per-block toggle or a hardcoded choice.                          | Explicit product decision: different users have different preferences for long lines, and it should be deliberately configured in Settings rather than an ambient per-block control or a one-size-fits-all default. |
| D4  | The setting is added to the existing `ChatSchema` (`api/src/config/env.ts`) and exposed through the existing `agent-behavior` settings slug — no new settings slug or route.    | `chat.showErrorMessages` already establishes this exact shape (a chat display boolean under `agent-behavior`'s PATCH schema, which is already `ChatSchema.partial()`). Reusing it is free; a new slug would duplicate existing plumbing for one boolean. |
| D5  | Other pages read the setting through a new small global signal module (`use-chat-display-settings.ts`), fetched once at the app root — not threaded as a prop through `<Markdown>`'s call sites. | `<Markdown>` is used from many unrelated pages (chat, wiki, dashboard, workspace chat). `use-providers.ts`'s module-level-signal-plus-TTL-cached-fetch pattern already solves "global, infrequently-changing, needed-in-many-places" data the same way; threading a prop everywhere would be a much larger, unjustified diff. |
| D6  | `CodeBlock` reads the signal directly, the same way `assistant-message.tsx` already reads `showErrorMessages` directly rather than receiving it as a prop.                     | Consistent with an established in-repo pattern for a global display preference consumed deep in a component tree.                                                                                           |

---

## 1. The whitespace fix

`CodeBlock`'s `<pre>` className becomes mode-dependent:

```tsx
className={cn(
  codeBlockWrap.value
    ? 'whitespace-pre-wrap break-words'
    : 'whitespace-pre overflow-x-auto',
  props.className,
)}
```

- **Scroll mode** (`codeBlockWrap.value === false`, default): `whitespace-pre`
  preserves every space/tab exactly; `overflow-x-auto` scrolls long lines
  horizontally within the block instead of overflowing the container.
- **Wrap mode** (`codeBlockWrap.value === true`): `whitespace-pre-wrap`
  preserves whitespace while allowing the line to wrap at the container
  edge; `break-words` (`overflow-wrap: break-word`) guards against a single
  unbroken long token (e.g. a long string literal with no spaces) forcing
  horizontal overflow with no scrollbar to reach it.
- `overflow-hidden` is removed — it was only ever clipping, not scrolling,
  and scroll mode now needs `overflow-x-auto` instead.

The Copy button is unchanged (`ref.current?.innerText`) — fixing the
rendered whitespace is sufficient, since `innerText` already reflects
whatever the `<pre>` actually renders.

## 2. Settings: `chat.codeBlockWrap`

`ChatSchema` (`api/src/config/env.ts`) gains:

```ts
codeBlockWrap: z.boolean().default(false),
```

No changes to `settings.handlers.ts`'s `agent-behavior` slug definition are
needed — its `get`/`patchSchema`/`write` already pass the whole `chat`
object/partial through.

### UI

A new "Code blocks" card in `agent-behavior-panel.tsx`, following the
existing `Switch` + `setField` pattern used for `showErrorMessages`:

- Label: "Wrap long lines in code blocks"
- Helper text: "Long lines wrap to fit instead of scrolling horizontally."
- `checked={form.value.chat?.codeBlockWrap ?? false}`
- `onCheckedChange={(v) => setField('chat.codeBlockWrap', v)}`

## 3. Propagating the setting to `CodeBlock`

New file `ui/src/hooks/use-chat-display-settings.ts`, mirroring
`use-providers.ts`'s module-level-signal + TTL-cached-fetch shape:

```ts
export const codeBlockWrap = signal<boolean>(false);

export async function fetchChatDisplaySettings(): Promise<void> {
  // TTL-cached (same 60s window as fetchProviders), fetches
  // GET /api/v1/settings/agent-behavior and sets codeBlockWrap.value
  // from the response's chat.codeBlockWrap.
}
```

Called once from `app.tsx`'s root `useEffect`, next to the existing
`connectLiveEvents()` call — fetched once per tab session, available to
every page without per-page plumbing.

`markdown.tsx` imports `codeBlockWrap` from this module and reads
`codeBlockWrap.value` in `CodeBlock` per §1.

As with `providers`/`favoriteModels` today, a change saved in Settings
reaches other already-open tabs only on their own next TTL-cached fetch or
page reload — existing behavior for every global setting in this app, not
a new limitation introduced here.

## 4. Testing

Per root `AGENTS.md` and `ui`/`api` `AGENTS.md` conventions:

**`ui/` (Jest):**

- `markdown.test.tsx` [unit] — extend: `CodeBlock` preserves multi-space
  indentation in rendered output for both `codeBlockWrap` values (render
  content with leading whitespace, assert the rendered text isn't
  collapsed — e.g. assert on `textContent` matching the original including
  spaces, and/or the computed `white-space` isn't `pre-line`); applies
  `overflow-x-auto` when `false` and `whitespace-pre-wrap`/`break-words`
  when `true`; Copy button writes the unmodified original text to the
  clipboard (spy on `navigator.clipboard.writeText`) regardless of mode.
- `use-chat-display-settings.test.ts` [unit] — new. `fetchChatDisplaySettings`
  sets `codeBlockWrap.value` from a mocked `GET /api/v1/settings/agent-behavior`
  response; TTL-cache behavior (a second call within the window doesn't
  refetch), mirroring whatever `use-providers.test.ts` already asserts for
  `fetchProviders` if that test exists.
- `agent-behavior-panel.test.tsx` [unit] (or wherever existing coverage for
  this panel lives) — extend: the new Switch reflects
  `chat.codeBlockWrap` and calls `setField('chat.codeBlockWrap', v)` on
  toggle, same assertions as the existing `showErrorMessages` Switch.

**`api/` (Mocha + Chai):**

- `routes/v1/settings.handlers.test.ts` [unit] — extend: `chat.codeBlockWrap`
  round-trips through `PATCH /api/v1/settings/agent-behavior`; defaults to
  `false` when absent from `config.yaml`.

**Playwright (`e2e/tests/`):**

- `@user-workflow`, extending or adding alongside the existing chat specs —
  mock thread hydration (`GET /api/v1/threads/:id`, per `e2e/AGENTS.md`'s
  "mock hydration, not the live turn" pattern) with an assistant message
  whose content includes a fenced code block with leading-space indentation
  (e.g. a small YAML snippet). Assert the rendered block's text preserves
  the indentation, then click the block's Copy button and assert
  `navigator.clipboard.writeText` (stubbed) was called with the
  unmodified, correctly-indented original text.
- `@user-workflow` — in Settings, toggle "Wrap long lines in code blocks"
  on and off; back on the mocked chat thread from above, confirm a
  long line scrolls horizontally with the setting off and wraps with it on
  (e.g. assert the block's `scrollWidth`/computed `white-space`, or that a
  horizontal scrollbar is/isn't present).

---

## 5. Out of scope

- Any change to the Copy button's implementation itself — it already reads
  rendered text correctly; only the rendering it reads was wrong.
- A per-block override of the global setting. Explicitly rejected during
  design in favor of one global, deliberately-configured preference (D3).
- Syntax highlighting, language detection, or any other `rehype-highlight`
  behavior — untouched by this change.
- Propagating a Settings change to other already-open tabs/pages faster
  than their existing TTL-cached fetch — consistent with how every other
  global setting in this app already behaves (see §3).
