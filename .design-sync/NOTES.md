# Design Sync Notes

## Build setup

This repo uses a **private npm registry** (`npm.artifacts.tdkottke.com`). The `.ds-sync` converter cannot use `npm ci` in environments without credentials.

**Workaround for local rebuild:**
```bash
# Install public deps to a temp dir
npm install --prefix /tmp/ds-deps \
  react@19 react-dom@19 preact lucide-preact \
  @tailwindcss/cli class-variance-authority radix-ui \
  @radix-ui/react-slot @radix-ui/primitive @fontsource-variable/geist

# Symlink into project
ln -s /tmp/ds-deps/node_modules ./node_modules   # if no real node_modules

# Create package stubs for the converter
mkdir -p node_modules/amazing-hashbrown-ui
# symlink to the actual ui/ directory:
ln -sf "$(pwd)/ui" node_modules/amazing-hashbrown-ui
ln -sf node_modules/lucide-preact node_modules/lucide-react

# Compile CSS
mkdir -p ui/dist
npx @tailwindcss/cli -i ./ui/src/style.css -o ./ui/dist/styles.css
cp node_modules/@fontsource-variable/geist/files/*.woff2 ./ui/dist/files/ 2>/dev/null || true

# Run converter
node .ds-sync/package-build.mjs \
  --config .design-sync/config.json \
  --node-modules ./node_modules \
  --out ./ds-bundle
```

## Config notes

- `srcDir: "src/components/ui"` — relative to `node_modules/amazing-hashbrown-ui` (symlinked to `ui/`)
- `tsconfig: "tsconfig.json"` — the `ui/tsconfig.json`, which has `@/` → `src/` path alias
- `cssEntry: "dist/styles.css"` — compiled Tailwind; must be inside `ui/dist/` (pkgRoot bound)
- `globalName: "hashbrown"` → `window.Hashbrown` on the page

## Component notes

- All 10 source files are in `ui/src/components/ui/`. The converter discovers 46 named exports (sub-components from Card, DropdownMenu, Select, Sheet).
- `Sheet` uses the project's custom `lib/preact-dialog/` for dialog primitives — excluded from sync since it uses Preact-native APIs incompatible with the React converter.
- Actually `Sheet` uses Radix UI `SheetPrimitive` directly — it is included. The `lib/preact-dialog/Dialog` is a separate component not in the design system export.
- The `buttonVariants` export is a CVA function, not a component — it is excluded from the sync (non-PascalCase export).

## Uploading the bundle

Once `ds-bundle/` is built, upload it via the Claude Design CLI with local credentials:
```bash
npx @anthropic-ai/design-sync upload ./ds-bundle
```
Or open https://claude.ai/design and use the manual upload option.
