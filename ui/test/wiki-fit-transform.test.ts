import {
  FIT_PADDING,
  GRAPH_SCALE_EXTENT,
  circleBounds,
  computeFitTransform,
  type Bounds,
  type FitTransform,
} from '@/pages/wiki/fit-transform';

enum TestTypes {
  UNIT = '[unit]',
}

const WIDTH = 800;
const HEIGHT = 600;

/** Where a world-space point lands on screen under a d3-zoom transform. */
function toScreen(t: FitTransform, x: number, y: number): { x: number; y: number } {
  return { x: x * t.k + t.x, y: y * t.k + t.y };
}

function expectCentred(t: FitTransform, bounds: Bounds): void {
  const centre = toScreen(t, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
  expect(centre.x).toBeCloseTo(WIDTH / 2);
  expect(centre.y).toBeCloseTo(HEIGHT / 2);
}

describe('computeFitTransform', () => {
  it(`scales large bounds down so every node fits inside the padded canvas ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
    const t = computeFitTransform({ bounds, width: WIDTH, height: HEIGHT });

    const topLeft = toScreen(t, bounds.minX, bounds.minY);
    const bottomRight = toScreen(t, bounds.maxX, bounds.maxY);
    expect(topLeft.x).toBeGreaterThanOrEqual(FIT_PADDING - 1e-9);
    expect(topLeft.y).toBeGreaterThanOrEqual(FIT_PADDING - 1e-9);
    expect(bottomRight.x).toBeLessThanOrEqual(WIDTH - FIT_PADDING + 1e-9);
    expect(bottomRight.y).toBeLessThanOrEqual(HEIGHT - FIT_PADDING + 1e-9);
    expectCentred(t, bounds);
  });

  it(`uses the tighter axis so a wide graph is not clipped on the sides ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 0, minY: 0, maxX: 1440, maxY: 100 };
    const t = computeFitTransform({ bounds, width: WIDTH, height: HEIGHT });
    expect(t.k).toBeCloseTo((WIDTH - 2 * FIT_PADDING) / 1440);
  });

  it(`caps zoom-in at the zoom's max scale so Recenter never goes past what scrolling allows ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(computeFitTransform({ bounds, width: WIDTH, height: HEIGHT }).k).toBe(
      GRAPH_SCALE_EXTENT[1],
    );
  });

  it(`floors zoom-out at the zoom's min scale for enormous graphs ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 };
    expect(computeFitTransform({ bounds, width: WIDTH, height: HEIGHT }).k).toBe(
      GRAPH_SCALE_EXTENT[0],
    );
  });

  it(`centres zero-size bounds (a single node) at 1x rather than zooming in ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 120, minY: -40, maxX: 120, maxY: -40 };
    const t = computeFitTransform({ bounds, width: WIDTH, height: HEIGHT });
    expect(t.k).toBe(1);
    expectCentred(t, bounds);
  });

  it(`brings bounds far from the origin back to the canvas centre (panned into the void) ${TestTypes.UNIT}`, () => {
    const bounds = { minX: -5000, minY: 3000, maxX: -4800, maxY: 3200 };
    const t = computeFitTransform({ bounds, width: WIDTH, height: HEIGHT });
    expectCentred(t, bounds);
  });

  it(`still fits after the canvas shrinks, e.g. when the chat panel is widened ${TestTypes.UNIT}`, () => {
    const bounds = { minX: 0, minY: 0, maxX: 700, maxY: 500 };
    const narrow = 420;
    const t = computeFitTransform({ bounds, width: narrow, height: HEIGHT });
    expect(toScreen(t, bounds.maxX, 0).x).toBeLessThanOrEqual(narrow - FIT_PADDING + 1e-9);
    expect(toScreen(t, bounds.minX, 0).x).toBeGreaterThanOrEqual(FIT_PADDING - 1e-9);
  });
});

describe('circleBounds', () => {
  it(`returns null when there are no nodes, so Recenter has nothing to do ${TestTypes.UNIT}`, () => {
    expect(circleBounds([])).toBeNull();
  });

  it(`includes each node's radius so edge nodes are not clipped by the fit ${TestTypes.UNIT}`, () => {
    expect(
      circleBounds([
        { x: 0, y: 0, r: 10 },
        { x: 100, y: 50, r: 20 },
      ]),
    ).toEqual({ minX: -10, minY: -10, maxX: 120, maxY: 70 });
  });

  it(`collapses a single node to a point so it is centred at 1x ${TestTypes.UNIT}`, () => {
    expect(circleBounds([{ x: 30, y: 40, r: 12 }])).toEqual({
      minX: 30,
      minY: 40,
      maxX: 30,
      maxY: 40,
    });
  });
});
