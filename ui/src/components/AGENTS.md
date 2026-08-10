# AGENTS.md — ui/src/components

Component-level conventions for the Preact frontend. See `ui/AGENTS.md` for
project-wide layout, styling, and command reference.

This folder holds components reused across 2+ pages. Page-specific
components follow the same conventions below but live under
`src/pages/<name>/` instead — see `ui/AGENTS.md`'s "Where does this file
go?" section.

## Dialogs

Dialogs use the `Dialog` component from `@tkottke90/preact-dialog` (the
workspace package in `lib/preact-dialog`). It wraps the native `<dialog>`
element and follows a trigger-as-prop pattern. Existing examples:
`NewDomainModal` (`wiki/new-domain-form.tsx`) and `UploadWikiDialog`
(`wiki/upload-wiki-form.tsx`).

### The pattern

Split every dialog into two components:

1. **A dialog wrapper** (`<Name>Dialog` / `<Name>Modal`) — renders `<Dialog>`
   with the trigger element and the content component as a child.
2. **A content/form component** — rendered inside `<Dialog>`, so it can call
   `useDialog()` to access the dialog context (most importantly `close()`).

```tsx
import { Dialog, useDialog } from '@tkottke90/preact-dialog';

export function ExampleDialog() {
  return (
    <Dialog
      title="Example"
      trigger={
        <button type="button" title="Open example">
          Open
        </button>
      }
    >
      <ExampleForm />
    </Dialog>
  );
}

function ExampleForm() {
  const { close } = useDialog();

  function handleSubmit(e: Event) {
    e.preventDefault();
    // ... do work, reset local state ...
    close();
  }

  return <form onSubmit={handleSubmit}>{/* ... */}</form>;
}
```

### Rules

- The trigger goes in the `trigger` prop, **not** as a sibling of `<Dialog>`.
  `Dialog` clones the element and attaches the click listener that opens the
  modal itself — do not add your own `onClick`/open-state signal to the
  trigger.
- `useDialog()` only works in components rendered as children of `<Dialog>`.
  That is why the content lives in its own component instead of inline in the
  wrapper: the wrapper renders the provider, the child consumes it.
- Close the dialog with `close()` from `useDialog()` (Cancel buttons, after a
  successful submit, etc.). Reset any local form state before calling it —
  dialog children stay mounted while the dialog is hidden, so state persists
  across open/close otherwise.
- The dialog's built-in X button closes without running your handlers; use
  the `onCancel`/`onClose` props on `<Dialog>` if you need cleanup on that
  path too.
- `title` sets the dialog heading; `className` extends the dialog panel's
  styles (e.g. width/margin overrides — see `NewDomainModal`).
