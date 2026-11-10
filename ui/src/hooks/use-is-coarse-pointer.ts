// Whether the device's *primary* pointer is coarse (touch/stylus) rather
// than fine (mouse/trackpad) — read once on mount, not kept live. Unlike
// useMediaQuery/useIsMobileViewport (use-media-query.ts), which exist
// specifically to stay live across viewport resizes, this hook answers a
// different, one-shot question: "can this user reliably hold Shift while
// pressing Enter right now?" A live-subscribing version would let a
// Bluetooth keyboard connecting/disconnecting mid-conversation silently
// flip Enter's behavior under the user's fingers — see ADR-0061 and the
// design spec's D1-D3 for the full rationale, including why this is
// deliberately NOT OR'd with `navigator.maxTouchPoints > 0`.
//
// Not built on useMediaQuery on purpose (D3): that hook's contract is
// "stay live"; bolting a "read once and freeze" mode onto it would
// conflate two different contracts.
export function useIsCoarsePointer(): boolean {
  // No useState/useEffect — there is deliberately no listener to set up.
  // If matchMedia/the `pointer` feature is unavailable, `.matches` reads
  // as `false` (today's desktop behavior), the safe default.
  return window.matchMedia('(pointer: coarse)').matches;
}
