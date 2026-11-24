import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Asserts a Drawer/BottomSheet's DialogFooter is pinned to the bottom of
 * the panel rather than scrolling with the content:
 *
 * 1. The body actually overflows (otherwise the check proves nothing —
 *    pick a viewport short enough to force it).
 * 2. The footer is fully inside the viewport before any scrolling.
 * 3. Scrolling the body to its end doesn't move the footer.
 */
export async function expectPinnedFooter(page: Page, dialog: Locator) {
  const body = dialog.locator('[data-slot="dialog-body"]');
  const footer = dialog.locator('[data-slot="dialog-footer"]');

  await expect(footer).toBeVisible();
  // Drawer/BottomSheet slide in via CSS transitions; measure only once
  // they've settled so a mid-animation box doesn't skew the positions.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );

  const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflows, 'dialog body should overflow at this viewport so pinning is exercised').toBe(
    true,
  );

  const viewportHeight = page.viewportSize()?.height ?? 0;
  const before = await footer.boundingBox();
  expect(before, 'footer has a layout box').not.toBeNull();
  expect(
    before!.y + before!.height,
    'footer should be fully on-screen without scrolling',
  ).toBeLessThanOrEqual(viewportHeight);

  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect
    .poll(async () => body.evaluate((el) => el.scrollTop), {
      message: 'body should have scrolled',
    })
    .toBeGreaterThan(0);

  const after = await footer.boundingBox();
  expect(after?.y, 'footer should not move when the body scrolls').toBe(before!.y);
}
