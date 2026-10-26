// Hand-duplicated from @tkottke90/amazing-hashbrown-widgets/types, same
// reason as the llm-common-types mock in this same directory: that package
// is ESM-only and can't be require()'d by Jest's CJS runtime as a value —
// only type-only imports of it (erased at compile time) work directly.
// Every existing consumer across this codebase only ever imports types
// (already erased, never touching this mock); this file exists purely for
// the handful of places that need WIDGET_SIZE_MIN/MAX as a real runtime
// value (the resize handle's clamp).
export const WIDGET_SIZE_MIN: Record<
  'markdown' | 'big-number' | 'line-graph' | 'pie-graph' | 'system' | 'spacer',
  { w: number; h: number }
> = {
  'big-number': { w: 2, h: 2 },
  'line-graph': { w: 4, h: 3 },
  'pie-graph': { w: 4, h: 3 },
  markdown: { w: 3, h: 2 },
  system: { w: 3, h: 2 },
  spacer: { w: 1, h: 1 },
};

export const WIDGET_SIZE_MAX = { w: 12, h: 8 } as const;
