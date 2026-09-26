// Pure geometry for the graph's "Recenter graph" button: find the zoom/pan
// transform that fits every rendered node inside the SVG. Kept free of d3 and
// the DOM so it can be unit tested directly.

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FitTransform {
  /** Scale */
  k: number;
  /** Translate x */
  x: number;
  /** Translate y */
  y: number;
}

export interface FitTransformOptions {
  bounds: Bounds;
  width: number;
  height: number;
  padding?: number;
  /** Must match the zoom behaviour's scaleExtent so Recenter never lands on
   * a zoom level the user couldn't reach by scrolling. */
  scaleExtent?: [number, number];
}

export const FIT_PADDING = 40;
export const GRAPH_SCALE_EXTENT: [number, number] = [0.2, 4];

/**
 * Bounding box of circles centred at (x, y) with radius r, or null for none.
 * A lone circle yields zero-size bounds at its centre, so Recenter centres it
 * at 1x instead of zooming in until one node fills the canvas.
 */
export function circleBounds(
  circles: ReadonlyArray<{ x: number; y: number; r: number }>,
): Bounds | null {
  if (circles.length === 0) return null;
  if (circles.length === 1) {
    const { x, y } = circles[0]!;
    return { minX: x, minY: y, maxX: x, maxY: y };
  }
  const bounds: Bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const { x, y, r } of circles) {
    bounds.minX = Math.min(bounds.minX, x - r);
    bounds.minY = Math.min(bounds.minY, y - r);
    bounds.maxX = Math.max(bounds.maxX, x + r);
    bounds.maxY = Math.max(bounds.maxY, y + r);
  }
  return bounds;
}

export function computeFitTransform({
  bounds,
  width,
  height,
  padding = FIT_PADDING,
  scaleExtent = GRAPH_SCALE_EXTENT,
}: FitTransformOptions): FitTransform {
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;

  let k = 1;
  if (boundsWidth > 0 && boundsHeight > 0) {
    const availableWidth = Math.max(1, width - 2 * padding);
    const availableHeight = Math.max(1, height - 2 * padding);
    k = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);
    k = Math.min(scaleExtent[1], Math.max(scaleExtent[0], k));
  }

  // Map the bounds' centre onto the canvas centre: screen = world * k + t.
  return { k, x: width / 2 - centreX * k, y: height / 2 - centreY * k };
}
