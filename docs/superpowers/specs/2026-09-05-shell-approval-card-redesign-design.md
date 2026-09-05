# Shell approval card redesign

Issue: [tkottke90/amazing-hashbrown#133](https://github.com/tkottke90/amazing-hashbrown/issues/133)

## Problem

The `shell_approval` HITL card in the chat window dumps the raw, unformatted
`shell_exec` command into the card body (`hitl-prompt-message.tsx`'s
`shell_approval` branch). This is unreadable (no syntax highlighting,
heredoc/multi-command scripts run together as a wall of text) and can blow
out the chat layout: the `<pre>` has `overflow-hidden` but no height cap, so
`overflow-hidden` doesn't stop the element itself from growing arbitrarily
tall for a long or multi-line command. The agent-supplied `reason` — the
part a user actually needs to make an approve/deny decision — is rendered
second, small, and muted.

Correction to the issue's premise, and a correction to this design doc's
first draft: the issue states a `Dialog` component already exists at
`ui/src/components/ui/dialog.tsx`. That exact path is wrong — nothing
lives there, only `sheet.tsx` (a slide-in drawer on Radix's `Dialog`
primitive) does. But the issue's broader claim was right: this codebase
already has a real, actively-used, documented modal system —
`@tkottke90/preact-dialog` (workspace package at `lib/preact-dialog`,
exporting `Modal`/`Dialog`/`Drawer`/`useDialog`), used across the app
(settings modals, workspace drawers, wiki upload/domain forms) and
specified in `ui/src/components/AGENTS.md`'s "Dialogs" section. An earlier
version of this design missed that package (it only searched
`ui/src/components/ui/`) and proposed building a brand-new Radix-based
`Dialog` component mirroring `sheet.tsx`. That was unnecessary and would
have introduced a second, inconsistent modal implementation alongside the
existing one. This design reuses `Modal` from `@tkottke90/preact-dialog`
instead.

## Goals

- `reason` becomes the card's primary, prominent content.
- The raw command is never inlined into the card. It's available on demand
  via a "View command" action.
- The card's own markup can never grow taller than a fixed number of lines
  regardless of command length — the overflow bug becomes structurally
  impossible, not just visually mitigated.
- The full-command viewer scrolls internally and never affects the
  surrounding chat layout, no matter how long the command is.

## Backend: make `reason` required on `shell_exec`

`api/src/agents/tools/shell-exec.tool.ts`'s `ShellExecSchema.reason` drops
`.optional()` and gains `.min(1, ...)`, so an empty string doesn't satisfy
"required" in practice:

```ts
reason: z
  .string()
  .min(1, 'reason is required')
  .describe('Explain why this command is needed (shown to user if approval is required)'),
```

This only changes the Zod schema the LLM's tool-calling API validates
against. It does **not** touch:

- `ApprovalCallback` / `ShellExecutor` in `lib/shell-executor` — `reason`
  stays optional there (`(command: string, reason?: string) => ...`).
  `lib/skills-manager`'s runner (`runJsScript`/`runPythonScript` via
  `runner.ts`) calls `executor.execute(command)` with no reason at all for
  its own internal, non-agent-driven use, and that's a legitimate,
  unrelated call site.
- `HitlPromptFields.reason` (`thread-message-writer.ts`) and the persisted
  `HitlThreadMessage.reason` / UI type (`thread-message.ts`) — these stay
  optional. Thread rows written before this change won't have a `reason`,
  so the UI must keep a fallback for that case (see below).

`system-prompt.ts`'s `SHELL_EXECUTION_SECTION` already instructs the model
to "always fill in the reason field" — no wording change needed; this just
backs that guidance with enforcement.

## UI: approval card redesign

`ui/src/components/hitl-prompt-message.tsx`, `shell_approval` branch is
restructured to:

1. **Reason, prominent, first**: `text-sm text-foreground` (not muted),
   directly under the question header. Fallback for legacy rows without one:
   `"No reason was provided for this command."`
2. **One-line command preview + "View command" button**, in a flex row:
   - Preview text is `message.command.split('\n')[0]`, rendered
     `font-mono text-xs truncate` inside a `min-w-0 flex-1` container.
     CSS `truncate` (ellipsis) caps it to exactly one line regardless of
     how long that first line is — no JS truncation logic needed.
   - A "View command" button, passed as the `trigger` prop of a `Modal`
     (per the codebase's documented trigger-as-prop pattern — see below),
     opens a dialog with the full raw command.
3. Deny / Approve & remember / Approve buttons: unchanged, same row.

Nothing in the card's own markup can grow past a fixed height based on
command content — the overflow bug is closed structurally.

## Command viewer: reuse `Modal` + `CodeBlock`

No new component is built. The full command is shown using two pieces that
already exist and are already composed together elsewhere in this exact
way (`ui/src/pages/wiki/upload-wiki-form.tsx` uses `CodeBlock` inside a
`Modal` for command-like content, including a scrollable
`max-h-40 overflow-y-auto whitespace-pre-wrap` override on a failed-upload
error dump):

- **`Modal`** from `@tkottke90/preact-dialog` — the "trigger-as-prop"
  dialog pattern documented in `ui/src/components/AGENTS.md`: the trigger
  element is passed via the `trigger` prop (not rendered as a sibling),
  and `Modal` clones it to attach the open handler. `Button` is already
  built to support this (`ui/src/components/ui/button.tsx`'s `forwardRef`
  wrapper exists specifically so it works as a `Dialog`/`Modal` trigger).
  Native `<dialog>` under the hood, shown via `showModal()`.
- **`CodeBlock`** from `ui/src/components/markdown.tsx` — used directly
  with the raw command string as children (no `Markdown`/`ReactMarkdown`
  wrapping, no fenced-code-block string building, no backtick-collision
  risk), with a `className` override
  (`max-h-[60vh] overflow-y-auto whitespace-pre-wrap`) that `cn()`
  (tailwind-merge-backed) correctly resolves against `CodeBlock`'s own
  default `overflow-hidden whitespace-pre-line`. This is the actual fix
  for the layout-blowout bug: no matter how long the command, this element
  scrolls internally and the page/chat layout is never affected. No
  syntax highlighting in this mode (that only comes from
  `rehype-highlight` in the full `Markdown` pipeline) — acceptable per the
  issue's own fallback ask ("or at least monospace + line-wrapped +
  scrollable"), and consistent with how `CodeBlock` is already used
  standalone elsewhere in this app.

```tsx
<Modal
  title="Command"
  trigger={
    <Button size="sm" variant="ghost">
      View command
    </Button>
  }
>
  <CodeBlock className="mt-2 max-h-[60vh] overflow-y-auto whitespace-pre-wrap">
    {message.command}
  </CodeBlock>
</Modal>
```

## Testing

This codebase has no UI component unit tests (`ui/test/*.test.ts` covers
hooks/pure functions via jest; component behavior is verified through
Playwright e2e) and no existing tests for `shell-exec.tool.ts`.

- Extend `e2e/tests/hitl-shell-approval.spec.ts` with a case asserting: the
  reason text is visible and prominent, the command preview shows only the
  first line, and clicking "View command" opens a dialog (`page.getByRole('dialog')`
  — the same assertion pattern already used against this same `Modal`
  component in `e2e/tests/settings-save-contracts.spec.ts`) with the full
  multi-line command visible.
- Add a Mocha unit test for `ShellExecSchema` confirming a tool call
  omitting (or empty-stringing) `reason` fails validation.

## Out of scope

- Changing `ApprovalCallback`/`ShellExecutor` library-level typing.
- A truncated inline preview beyond the single first line (no "show 3
  lines then fade" or similar — one line, CSS ellipsis, done).
- Syntax highlighting for the full command view. `CodeBlock` only gets
  highlight.js coloring when fed through the `Markdown`/`rehype-highlight`
  pipeline; used directly (as here, and as already done elsewhere in this
  app) it's plain monospace text. Matches the issue's own accepted
  fallback and existing codebase precedent — not pursued further.
