# D3 for widget chart rendering, not a charting library

Line Graph and Pie Graph widgets render via `d3-shape` (line/arc/pie generators) and `d3-scale`, driven imperatively through a `useRef<SVGSVGElement>` + `useEffect`, the same integration pattern `ui/src/pages/wiki/graph-view.tsx` already uses for the Wiki force graph (`d3-force`/`d3-selection`/`d3-drag`/`d3-zoom`). We considered a React-oriented charting library (e.g. Recharts) aliased through the existing `preact/compat` setup, but rejected it: it would be this app's first chart dependency stacked on top of an existing, uncomposed D3 investment, for rendering needs — a sparkline-style line, a basic pie — simple enough to hand-roll.

## Considered Options

- A React/Preact-compat charting library (Recharts, etc.) — rejected: new dependency, new compat-aliasing risk, for a need D3 (already a dependency family here) covers directly.
- Canvas-based rendering — rejected: SVG composes more naturally with this app's existing Tailwind/CSS-variable theming and needs no separate light/dark redraw logic.
