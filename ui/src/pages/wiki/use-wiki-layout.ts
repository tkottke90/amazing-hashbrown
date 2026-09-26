import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';

// Persisted, resettable layout for the /wiki page's two resizable splits:
//   wiki-outer    — canvas | chat  (shared by Graph and Document views)
//   wiki-document — files | document (Document view only)
//
// Persistence lives here rather than in the library's useDefaultLayout hook
// because Reset has to clear the wiki-document layout while that group is
// unmounted (Graph view), and useDefaultLayout picks its own storage keys.
// Rule shared by Reset and separator double-click: no stored layout means
// the panels' default sizes apply.

export const OUTER_GROUP_ID = 'wiki-outer';
export const DOCUMENT_GROUP_ID = 'wiki-document';

// Panel and separator ids double as DOM ids (and data-testid) on the
// rendered elements, so they're namespaced rather than bare `chat` etc.
export const CANVAS_PANEL_ID = 'wiki-canvas';
export const CHAT_PANEL_ID = 'wiki-chat';
export const FILES_PANEL_ID = 'wiki-files';
export const DOC_PANEL_ID = 'wiki-doc';
export const OUTER_SEPARATOR_ID = 'wiki-outer-separator';
export const DOCUMENT_SEPARATOR_ID = 'wiki-document-separator';

export type WikiLayoutGroupId = typeof OUTER_GROUP_ID | typeof DOCUMENT_GROUP_ID;

// Sizes: numbers are pixels, strings are percentages (react-resizable-panels v4).
// Percentages must carry an explicit `%`: before the first layout the library
// renders `defaultSize` straight into `flex-basis`, where a bare "65" is invalid
// CSS. The panels then start content-sized, the group's width is measured from
// them, and every pixel constraint is derived from that wrong width — the
// layout comes up skewed and the separators stop responding.
// Defaults reproduce the pre-resizable layout: 65fr/35fr grid, w-56 file list.
export const OUTER_SIZES = {
  canvas: { defaultSize: '65%', minSize: 400 },
  chat: { defaultSize: '35%', minSize: 280, maxSize: '60%' },
} as const;

export const FILES_DEFAULT_PX = 224;
export const FILES_MIN_PX = 160;
export const FILES_MAX_PERCENT = 40;
export const DOCUMENT_MIN_PX = 320;

export const DOCUMENT_SIZES = {
  files: {
    defaultSize: FILES_DEFAULT_PX,
    minSize: FILES_MIN_PX,
    maxSize: `${FILES_MAX_PERCENT}%`,
  },
  // No defaultSize on purpose: separator double-click resets the first
  // adjacent panel that declares one, which has to be `files`.
  document: { minSize: DOCUMENT_MIN_PX },
} as const;

const PANEL_IDS: Record<WikiLayoutGroupId, readonly string[]> = {
  [OUTER_GROUP_ID]: [CANVAS_PANEL_ID, CHAT_PANEL_ID],
  [DOCUMENT_GROUP_ID]: [FILES_PANEL_ID, DOC_PANEL_ID],
};

export const OUTER_DEFAULT_LAYOUT: Layout = { [CANVAS_PANEL_ID]: 65, [CHAT_PANEL_ID]: 35 };

function storageKey(groupId: WikiLayoutGroupId): string {
  return `wiki-layout:${groupId}`;
}

function isValidLayout(groupId: WikiLayoutGroupId, value: unknown): value is Layout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const expected = PANEL_IDS[groupId];
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((id) => keys.includes(id))) return false;
  return Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Stored layout for a group, or undefined (→ panel defaults) if absent, unreadable or invalid. */
export function loadLayout(groupId: WikiLayoutGroupId): Layout | undefined {
  try {
    const raw = localStorage.getItem(storageKey(groupId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isValidLayout(groupId, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(groupId: WikiLayoutGroupId, layout: Layout): void {
  try {
    localStorage.setItem(storageKey(groupId), JSON.stringify(layout));
  } catch {
    // localStorage unavailable (e.g. private browsing) — layout just isn't remembered
  }
}

export function clearLayout(groupId: WikiLayoutGroupId): void {
  try {
    localStorage.removeItem(storageKey(groupId));
  } catch {
    // best-effort only
  }
}

/**
 * onLayoutChanged handler for a group. Only user-driven changes (drag release,
 * keyboard resize) are saved — the library also reports clamping when the
 * window shrinks, and persisting that would permanently shrink the layout.
 */
export function persistOnUserChange(groupId: WikiLayoutGroupId) {
  return (layout: Layout, meta: { isUserInteraction: boolean }): void => {
    if (meta.isUserInteraction) saveLayout(groupId, layout);
  };
}

/** Bumped by resetWikiLayout(); mounted groups watch it via useLayoutReset(). */
export const layoutResetCount = signal(0);

export function resetWikiLayout(): void {
  clearLayout(OUTER_GROUP_ID);
  clearLayout(DOCUMENT_GROUP_ID);
  layoutResetCount.value += 1;
}

/**
 * Default files|document layout as percentages for a group `groupWidthPx`
 * wide. setLayout() only accepts percentages, so the 224px default has to be
 * converted, clamped to the files min/max and the document minimum.
 */
export function documentDefaultLayout(groupWidthPx: number): Layout {
  if (!(groupWidthPx > 0)) {
    return { [FILES_PANEL_ID]: 25, [DOC_PANEL_ID]: 75 };
  }
  const maxFilesPx = Math.min(
    (groupWidthPx * FILES_MAX_PERCENT) / 100,
    groupWidthPx - DOCUMENT_MIN_PX,
  );
  const filesPx = Math.max(FILES_MIN_PX, Math.min(FILES_DEFAULT_PX, maxFilesPx));
  const files = Math.min(100, (filesPx / groupWidthPx) * 100);
  return { [FILES_PANEL_ID]: files, [DOC_PANEL_ID]: 100 - files };
}

/**
 * Applies `getDefault()` to a mounted group whenever resetWikiLayout() runs
 * after this component mounted. Resets that happened before mount are
 * already covered — the stored layout was cleared, so the group mounts with
 * its defaults.
 *
 * `afterNextFrame` defers the reset by one animation frame. The document
 * group needs it: its default is a pixel width converted to a percentage of
 * the group's current width, and both groups reset in the same commit (the
 * nested document group's effect even runs first). Waiting a frame lets the
 * outer group's reset re-render the canvas at its default width before the
 * document group measures it.
 */
export function useLayoutReset(
  groupRef: RefObject<GroupImperativeHandle | null>,
  getDefault: () => Layout,
  { afterNextFrame = false }: { afterNextFrame?: boolean } = {},
): void {
  const count = layoutResetCount.value;
  const seen = useRef(count);

  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    const apply = () => groupRef.current?.setLayout(getDefault());
    if (!afterNextFrame) {
      apply();
      return;
    }
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [count]);
}
