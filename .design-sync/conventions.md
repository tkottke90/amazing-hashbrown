# Amazing Hashbrown UI — Design Conventions

## Stack
- **Framework:** Preact 10 (React-compat alias — import from `react` works)
- **Styling:** Tailwind CSS v4 with `@theme` inline tokens (no `tailwind.config.js`)
- **Variants:** `class-variance-authority` (CVA) for all multi-variant components
- **Primitives:** Radix UI via `radix-ui` package (Radix Nova bundling)
- **Icons:** `lucide-react` aliased to `lucide-preact`

## Token conventions
All design tokens live in `ui/src/style.css` under `@theme`. Semantic tokens follow shadcn/ui naming:

| Token group | Examples |
|---|---|
| Brand blue | `--color-blue-50` … `--color-blue-950` |
| Brand pink | `--color-night-shadz-50` … `--color-night-shadz-950` |
| Semantic | `--background`, `--foreground`, `--primary`, `--primary-foreground` |
| Muted | `--muted`, `--muted-foreground` |
| Destructive | `--destructive` |
| Ring / border | `--border`, `--input`, `--ring` |
| Radius | `--radius` (0.625 rem base), `--radius-sm` … `--radius-4xl` |

Dark mode is applied via the `.dark` class on a parent element (not `prefers-color-scheme`):
```css
@custom-variant dark (&:is(.dark *))
```

## Component conventions

### Slots (`data-slot`)
Every component sets `data-slot="<component-name>"` on its root element. Compound components use slot attributes to coordinate parent→child styling (e.g. `data-slot="card-header"` triggers grid layout in `Card`).

### asChild pattern
`Button` accepts `asChild` prop (Radix Slot): renders any child element instead of a `<button>`, forwarding all props. Use for link-styled buttons.

### CVA variants
`buttonVariants` is exported from `Button` for reuse in other components that need button-like styling without the `Button` wrapper.

### Compound component imports
All sub-components are named exports from the same package. Import everything needed from `amazing-hashbrown-ui`:
```tsx
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from 'amazing-hashbrown-ui';
```

## File structure
```
ui/src/components/ui/   ← all design system components
ui/src/lib/utils.ts     ← cn() utility (clsx + tailwind-merge)
ui/src/style.css        ← Tailwind entry + all design tokens
```
