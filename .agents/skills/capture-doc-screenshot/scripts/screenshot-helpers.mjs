// Shared helpers for one-off Playwright screenshot-capture driver scripts.
// See ../SKILL.md for the workflow these are meant to be used inside of.

/**
 * Bounding box (in page/viewport coordinates) covering every given
 * selector/locator. Use this when the screenshot's real subject is more
 * than one element — e.g. a hovered node AND the card that pops up next
 * to it — so the padding step below wraps the whole thing, not just one
 * piece of it.
 *
 * @param {import('playwright').Page} page
 * @param {(string | import('playwright').Locator)[]} selectors
 */
export async function unionBoundingBox(page, selectors) {
  const boxes = [];
  for (const sel of selectors) {
    const locator = typeof sel === 'string' ? page.locator(sel) : sel;
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`No bounding box for selector/locator: ${sel}`);
    }
    boxes.push(box);
  }
  return {
    left: Math.min(...boxes.map((b) => b.x)),
    top: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.x + b.width)),
    bottom: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}

/**
 * Turns a content box (as returned by unionBoundingBox) into a
 * page.screenshot({ clip }) rect with padding applied on every side.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} box
 * @param {{pad?: number, viewport?: {width: number, height: number}, maxWidth?: number, maxHeight?: number}} [opts]
 *   pad — minimum clear space on every side (default 16, per this repo's
 *     screenshot rule — never pass less than 16 without a real reason).
 *   viewport — clamps the clip so it never asks for pixels outside the
 *     rendered page.
 *   maxWidth/maxHeight — caps runaway size. A stray, far-off element
 *     (an isolated node, a tooltip that landed somewhere unexpected) can
 *     blow the union box up into a mostly-empty image; capping and letting
 *     that one outlier fall outside the frame produces a far more useful
 *     screenshot than technically including everything.
 */
export function paddedClip(box, opts = {}) {
  const pad = opts.pad ?? 16;

  let x = Math.max(0, box.left - pad);
  let y = Math.max(0, box.top - pad);
  let width = box.right - box.left + pad * 2;
  let height = box.bottom - box.top + pad * 2;

  if (opts.maxWidth) width = Math.min(width, opts.maxWidth);
  if (opts.maxHeight) height = Math.min(height, opts.maxHeight);

  if (opts.viewport) {
    width = Math.min(width, opts.viewport.width - x);
    height = Math.min(height, opts.viewport.height - y);
  }

  return { x, y, width, height };
}
