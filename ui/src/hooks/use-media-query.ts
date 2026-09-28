import { useEffect, useState } from 'preact/hooks';

// Whether a CSS media query currently matches, kept live as the viewport
// changes. Wrap it in a named hook (see useIsMobileViewport) rather than
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

// The Tasks tab shows the five-lane drag-and-drop board only when all five
// lanes fit side by side (Tailwind's `lg`, 1024px); below that it shows the
// grouped mobile list. See the Kanban board v2 design, §3.
export function useIsWideBoardViewport(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
