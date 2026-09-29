import { useEffect, useState } from 'preact/hooks';

// Whether a CSS media query currently matches, kept live as the viewport
// changes. Wrap it in a named hook (see useIsDesktopViewport) rather than
// scattering raw query strings through components.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

// The shared mobile/desktop chrome gate for the workspace detail view
// (Tailwind's `lg`, 1024px): the Tasks tab's five-lane board vs. the grouped
// mobile list (Kanban board v2 design, §3), and the compact mobile header,
// tab strip, and Files tab single-pane mode below that breakpoint (workspace
// mobile detail redesign, D9).
export function useIsDesktopViewport(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
