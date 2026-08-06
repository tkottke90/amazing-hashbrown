# Hashbrown (amazing-hashbrown-ui@0.1.0)

This design system is the published amazing-hashbrown-ui React library, bundled as a single
browser global. All 46 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.Hashbrown`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.Hashbrown.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { Button } = window.Hashbrown;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<Button />);
```

## Tokens

218 CSS custom properties from amazing-hashbrown-ui. Names are
preserved verbatim from upstream. They are declared inside `_ds_bundle.css` (this DS ships one compiled stylesheet rather than separate token files).

- **color** (46): `--color-amber-100`, `--color-amber-400`, `--color-amber-700`, …
- **spacing** (4): `--tw-inset-shadow`, `--tw-inset-shadow-alpha`, `--tw-inset-ring-shadow`, …
- **typography** (12): `--font-sans`, `--font-mono`, `--font-weight-medium`, …
- **radius** (8): `--radius-sm`, `--radius-md`, `--radius-lg`, …
- **shadow** (9): `--tw-prose-kbd-shadows`, `--tw-prose-invert-kbd-shadows`, `--tw-shadow`, …
- **other** (139): `--spacing`, `--container-sm`, `--container-lg`, …

## Components

### general
- `Button`
- `Card`
- `CardAction`
- `CardContent`
- `CardDescription`
- `CardFooter`
- `CardHeader`
- `CardTitle`
- `Checkbox`
- `DropdownMenu`
- `DropdownMenuCheckboxItem`
- `DropdownMenuContent`
- `DropdownMenuGroup`
- `DropdownMenuItem`
- `DropdownMenuLabel`
- `DropdownMenuPortal`
- `DropdownMenuRadioGroup`
- `DropdownMenuRadioItem`
- `DropdownMenuSeparator`
- `DropdownMenuShortcut`
- `DropdownMenuSub`
- `DropdownMenuSubContent`
- `DropdownMenuSubTrigger`
- `DropdownMenuTrigger`
- `Input`
- `Label`
- `Select`
- `SelectContent`
- `SelectGroup`
- `SelectItem`
- `SelectLabel`
- `SelectScrollDownButton`
- `SelectScrollUpButton`
- `SelectSeparator`
- `SelectTrigger`
- `SelectValue`
- `Sheet`
- `SheetClose`
- `SheetContent`
- `SheetDescription`
- `SheetFooter`
- `SheetHeader`
- `SheetTitle`
- `SheetTrigger`
- `Switch`
- `Textarea`
