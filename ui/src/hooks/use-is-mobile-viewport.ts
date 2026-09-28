import { useMediaQuery } from './use-media-query';

// Tailwind v4's default `sm` breakpoint (unmodified in this app's
// style.css) is 640px — "mobile" here means narrower than that.
// Deliberately a viewport-width check, not a touch/pointer-capability one
// (e.g. `(pointer: coarse)`): the provider/model picker's mobile layout
// exists because long content overflows a narrow viewport, which a wide
// touchscreen doesn't suffer from and a narrow desktop window would.
const MOBILE_QUERY = '(max-width: 639px)';

export function useIsMobileViewport(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
