import type { ComponentChildren } from 'preact';

export function LocationProvider({ children }: { children: ComponentChildren }) {
  return <>{children}</>;
}

export function Router({ children }: { children: ComponentChildren }) {
  return <>{children}</>;
}

export function useLocation() {
  return { url: '/', path: '/', query: {}, route: () => {} };
}
