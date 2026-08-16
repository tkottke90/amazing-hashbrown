# @tkottke90/preact-dialog

A thin Preact wrapper around the browser's native `<dialog>` element. Pairs a trigger element with a modal, manages open/close lifecycle via DOM refs, and exposes context so deeply nested children can close the dialog without prop drilling.

`Dialog` owns all of the behavior (open/close/cancel lifecycle, trigger wiring, context) and none of the look. Positioning, sizing, and entrance/exit animation live in separate overlay-variant components — `Modal`, `Drawer`, `BottomSheet` — that each wrap `Dialog` with their own Tailwind classes. Reach for a variant in normal usage; use `Dialog` directly only when building a new overlay style.

## Installation

This package is private to the monorepo. It is consumed via the npm workspace alias:

```json
"@tkottke90/preact-dialog": "*"
```

### Peer dependencies

| Package           | Version                                |
| ----------------- | -------------------------------------- |
| `preact`          | `>=10.0.0`                             |
| `@preact/signals` | `>=1.0.0`                              |
| `lucide-preact`   | any (used for the built-in close icon) |

## Quick start

```tsx
import { Modal } from '@tkottke90/preact-dialog';

export function MyFeature() {
  return (
    <Modal trigger={<button>Open settings</button>} title="Settings">
      <p>Dialog content goes here.</p>
    </Modal>
  );
}
```

The `trigger` element is cloned with a `click` listener attached. Clicking it calls `showModal()` on the underlying `<dialog>` element.

## API

### `<Dialog>`

The base component. Renders the trigger, the native `<dialog>`, the header (title + optional ✕ close button), and provides `useDialog()` context — but carries no positioning, sizing, or animation classes of its own. Use one of the [overlay variants](#overlay-variants) below unless you're building a new style.

```tsx
<Dialog
  trigger={<button>Open</button>}
  title="My Dialog"
  onOpen={() => console.log('opened')}
  onClose={() => console.log('closed')}
  onCancel={() => console.log('cancelled (Escape)')}
  disableClose={false}
  className="extra-tailwind-classes"
  contentClassName="classes-for-the-inner-wrapper"
>
  {/* children */}
</Dialog>
```

| Prop               | Type                    | Default                 | Description                                                                                                                              |
| ------------------ | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `children`         | `ComponentChildren`     | —                       | Content rendered inside the dialog panel.                                                                                                |
| `trigger`          | `JSX.Element`           | `<button>Open</button>` | Element that opens the dialog on click. Receives a `ref` via `cloneElement`.                                                             |
| `title`            | `string \| JSX.Element` | —                       | Rendered in the dialog header alongside the close button.                                                                                |
| `disableClose`     | `boolean`               | `false`                 | Hides the built-in ✕ close button when `true`.                                                                                           |
| `className`        | `string`                | —                       | Extra CSS classes appended to the `<dialog>` element.                                                                                    |
| `contentClassName` | `string`                | —                       | CSS classes applied to the inner wrapper — where positioning/entrance-exit transform and backdrop-blur belong (see [Styling](#styling)). |
| `onOpen`           | `() => void`            | —                       | Called just before `showModal()`.                                                                                                        |
| `onClose`          | `() => void`            | —                       | Called when the dialog closes via `useDialog().close()`.                                                                                 |
| `onCancel`         | `() => void`            | —                       | Called when the dialog is dismissed via the ✕ button's cancel path or `cancelModal()`.                                                   |

> **Note:** `DialogProps` includes an `open?: Signal<boolean>` field, but the current implementation does not read it. Control the dialog through the `trigger` prop or `useDialog()` instead.
>
> **Note:** the ✕ close button calls `onCancel`, not `onClose` — `onClose` only fires via `useDialog().close()`.

#### Styling

`Dialog` itself only carries the shared "skin": padding, dark-mode-aware text/background colors, border, and corner radius. Everything about _where the overlay sits and how it enters/exits_ — positioning, sizing, z-index, transitions — belongs on the `className`/`contentClassName` supplied by whichever variant wraps it.

This split exists because of a DOM constraint worth knowing before adding a new variant: the slide/translate transform **and** the frosted-glass `backdrop-blur` must live on the inner wrapper div (`contentClassName`), never on the `<dialog>` element itself. Both `transform` and `backdrop-filter` independently establish a new containing block for `position: fixed` descendants — anything inside that relies on `position: fixed` (e.g. a Radix `Select` dropdown positioned via `getBoundingClientRect`) would render relative to the dialog's own box instead of the viewport. See the comment above the inner `<div>` in `Dialog.tsx` for the full explanation.

Because the inner wrapper doesn't itself get the dialog's `open` HTML attribute, direction-aware entrance classes use the ancestor-based arbitrary variant `[dialog[open]_&]:...` (Tailwind converts `_` to a space → `dialog[open] &`, i.e. "this element, when a `dialog[open]` ancestor exists") instead of `open:`.

---

## Overlay variants

Each variant wraps `Dialog`, supplying `className` (positioning/sizing/fade) and `contentClassName` (entrance/exit transform + blur). All accept every prop `Dialog` does (`DialogProps`) plus whatever is listed below, and all animate with `ease-out`.

### `<Modal>`

Centered dialog that fades in and slides up slightly. The default choice for confirmations, forms, and general-purpose dialogs.

```tsx
import { Modal } from '@tkottke90/preact-dialog';

<Modal trigger={<button>Open</button>} title="Confirm">
  <p>Are you sure?</p>
</Modal>;
```

No props beyond `DialogProps`.

### `<Drawer>`

Docks to a viewport edge and slides in horizontally. Full viewport height; 90% viewport width on mobile, sized to content (capped at 100ch) on larger screens. Use it for drilling into details, settings, or forms without leaving the current page context.

```tsx
import { Drawer } from '@tkottke90/preact-dialog';

<Drawer trigger={<button>Edit</button>} title="Edit item" side="left">
  <p>Form fields go here.</p>
</Drawer>;
```

| Prop   | Type                | Default   | Description                                                 |
| ------ | ------------------- | --------- | ----------------------------------------------------------- |
| `side` | `'left' \| 'right'` | `'right'` | Which viewport edge the drawer docks to and slides in from. |

### `<BottomSheet>`

Slides up from the bottom edge. Full width, capped at 90% of the viewport height (scrolls beyond that). Primarily a mobile/tablet pattern — a one-handed-friendly alternative to a side drawer.

```tsx
import { BottomSheet } from '@tkottke90/preact-dialog';

<BottomSheet trigger={<button>Actions</button>}>
  <p>Action list goes here.</p>
</BottomSheet>;
```

No props beyond `DialogProps`.

---

### `useDialog()`

Access the dialog's context from any descendant component:

```tsx
import { useDialog } from '@tkottke90/preact-dialog';

function SaveButton() {
  const { close } = useDialog();

  function handleSave() {
    // ... save logic
    close('saved'); // native dialog returnValue is set to 'saved'
  }

  return <button onClick={handleSave}>Save</button>;
}
```

| Property | Type                        | Description                                                                            |
| -------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `dialog` | `HTMLDialogElement \| null` | The underlying `<dialog>` DOM node.                                                    |
| `close`  | `(value?: string) => void`  | Calls `onClose` then closes the dialog; `value` becomes the dialog's `returnValue`.    |
| `value`  | `string \| undefined`       | The value passed to the last `close()` call (mirrors `HTMLDialogElement.returnValue`). |

---

### Helper functions

These are exported for cases where you need to drive a dialog imperatively from outside the component tree.

#### `openModal(modal, onOpen?)`

```ts
openModal(dialogRef.current, () => console.log('opened'));
```

Calls `showModal()` on the provided `HTMLDialogElement`. Invokes `onOpen` first if supplied.

#### `closeModal(modal, value?)`

```ts
closeModal(dialogRef.current, 'confirmed');
```

Calls `close(value)` on the provided element.

#### `cancelModal(modal, onCancel?)`

```ts
cancelModal(dialogRef.current, () => console.log('cancelled'));
```

Invokes `onCancel` then calls `closeModal`. Intended for Escape-key or explicit cancel paths.

---

### `usePortal(selector)`

Creates a portal attached to a DOM node matching `selector`. Falls back to `document.body` with a console warning if the selector yields no match.

```tsx
import { usePortal } from '@tkottke90/preact-dialog';

function Overlay() {
  const portal = usePortal('#modal-root');
  return portal(<div>Rendered outside the component tree</div>);
}
```

---

### `useHtmlElementListeners(events, inputs?)`

Returns a callback ref that registers multiple DOM event listeners on a node and cleans them up on unmount.

```tsx
import { useHtmlElementListeners } from '@tkottke90/preact-dialog';

function MyButton() {
  const ref = useHtmlElementListeners(
    [
      ['click', (e) => console.log('clicked', e)],
      ['keydown', (e) => console.log('key', e)],
    ],
    [], // dependency inputs (same semantics as useCallback)
  );

  return <button ref={ref}>Click me</button>;
}
```

---

### `registerEvent(element, eventName, event)`

Low-level helper that calls `addEventListener` and returns an unsubscribe function.

```ts
import { registerEvent } from '@tkottke90/preact-dialog';

const unsubscribe = registerEvent(buttonEl, 'click', handler);
// later:
unsubscribe();
```

---

## Build

```bash
npm run build --workspace lib/preact-dialog
# or in watch mode:
npm run dev --workspace lib/preact-dialog
```

Output is emitted to `dist/` as ESM `.js` files with co-located `.d.ts` declarations.
