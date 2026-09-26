import {
  CANVAS_PANEL_ID as CANVAS,
  CHAT_PANEL_ID as CHAT,
  DOC_PANEL_ID as DOC,
  FILES_PANEL_ID as FILES,
  DOCUMENT_GROUP_ID,
  DOCUMENT_MIN_PX,
  FILES_DEFAULT_PX,
  FILES_MAX_PERCENT,
  FILES_MIN_PX,
  OUTER_GROUP_ID,
  clearLayout,
  documentDefaultLayout,
  layoutResetCount,
  loadLayout,
  persistOnUserChange,
  resetWikiLayout,
  saveLayout,
} from '@/pages/wiki/use-wiki-layout';

const OUTER_KEY = `wiki-layout:${OUTER_GROUP_ID}`;
const DOCUMENT_KEY = `wiki-layout:${DOCUMENT_GROUP_ID}`;

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe('loadLayout — a bad stored value must never break the page', () => {
  it('returns undefined when nothing is stored, so panel defaults apply [unit]', () => {
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined for invalid JSON instead of throwing [unit]', () => {
    localStorage.setItem(OUTER_KEY, '{not json');
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined when the panel ids do not match the group, e.g. a renamed panel [unit]', () => {
    localStorage.setItem(OUTER_KEY, JSON.stringify({ [CANVAS]: 60, sidebar: 40 }));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined when a panel id is missing or extra [unit]', () => {
    localStorage.setItem(OUTER_KEY, JSON.stringify({ [CANVAS]: 100 }));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();

    localStorage.setItem(OUTER_KEY, JSON.stringify({ [CANVAS]: 50, [CHAT]: 30, extra: 20 }));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined when a size is not a finite number [unit]', () => {
    localStorage.setItem(OUTER_KEY, JSON.stringify({ [CANVAS]: '65', [CHAT]: 35 }));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();

    localStorage.setItem(OUTER_KEY, JSON.stringify({ [CANVAS]: null, [CHAT]: 35 }));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined for a non-object value such as an array [unit]', () => {
    localStorage.setItem(OUTER_KEY, JSON.stringify([65, 35]));
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('returns undefined when localStorage throws (e.g. private browsing) [unit]', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
  });

  it('does not accept one group’s layout for the other group [unit]', () => {
    localStorage.setItem(DOCUMENT_KEY, JSON.stringify({ [CANVAS]: 65, [CHAT]: 35 }));
    expect(loadLayout(DOCUMENT_GROUP_ID)).toBeUndefined();
  });
});

describe('saveLayout / clearLayout', () => {
  it('round-trips a saved layout so a resize survives reload [unit]', () => {
    saveLayout(OUTER_GROUP_ID, { [CANVAS]: 55.5, [CHAT]: 44.5 });
    expect(loadLayout(OUTER_GROUP_ID)).toEqual({ [CANVAS]: 55.5, [CHAT]: 44.5 });
  });

  it('does not throw when localStorage refuses writes — the layout just is not remembered [unit]', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveLayout(OUTER_GROUP_ID, { [CANVAS]: 50, [CHAT]: 50 })).not.toThrow();
  });

  it('clearLayout removes only its own group’s layout (double-click resets one split) [unit]', () => {
    saveLayout(OUTER_GROUP_ID, { [CANVAS]: 50, [CHAT]: 50 });
    saveLayout(DOCUMENT_GROUP_ID, { [FILES]: 30, [DOC]: 70 });

    clearLayout(OUTER_GROUP_ID);

    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
    expect(loadLayout(DOCUMENT_GROUP_ID)).toEqual({ [FILES]: 30, [DOC]: 70 });
  });
});

describe('persistOnUserChange', () => {
  it('saves layouts caused by the user dragging or using the keyboard [unit]', () => {
    persistOnUserChange(OUTER_GROUP_ID)({ [CANVAS]: 40, [CHAT]: 60 }, { isUserInteraction: true });
    expect(loadLayout(OUTER_GROUP_ID)).toEqual({ [CANVAS]: 40, [CHAT]: 60 });
  });

  it('ignores non-user changes so a briefly small window cannot permanently shrink the layout [unit]', () => {
    saveLayout(OUTER_GROUP_ID, { [CANVAS]: 40, [CHAT]: 60 });
    persistOnUserChange(OUTER_GROUP_ID)({ [CANVAS]: 70, [CHAT]: 30 }, { isUserInteraction: false });
    expect(loadLayout(OUTER_GROUP_ID)).toEqual({ [CANVAS]: 40, [CHAT]: 60 });
  });
});

describe('resetWikiLayout', () => {
  it('clears both splits, including the document split while Graph view has it unmounted [unit]', () => {
    saveLayout(OUTER_GROUP_ID, { [CANVAS]: 50, [CHAT]: 50 });
    saveLayout(DOCUMENT_GROUP_ID, { [FILES]: 30, [DOC]: 70 });

    resetWikiLayout();

    expect(loadLayout(OUTER_GROUP_ID)).toBeUndefined();
    expect(loadLayout(DOCUMENT_GROUP_ID)).toBeUndefined();
  });

  it('bumps layoutResetCount so mounted groups apply their defaults [unit]', () => {
    const before = layoutResetCount.value;
    resetWikiLayout();
    expect(layoutResetCount.value).toBe(before + 1);
  });
});

describe('documentDefaultLayout — setLayout needs percentages, the default is 224px', () => {
  function filesPx(width: number): number {
    return (documentDefaultLayout(width)[FILES]! / 100) * width;
  }

  it('converts the 224px default into the matching percentage at a typical width [unit]', () => {
    const layout = documentDefaultLayout(1000);
    expect(layout[FILES]).toBeCloseTo((FILES_DEFAULT_PX / 1000) * 100);
    expect(layout[FILES]! + layout[DOC]!).toBeCloseTo(100);
  });

  it('keeps the file list at 224px on a very wide group rather than scaling it up [unit]', () => {
    expect(filesPx(4000)).toBeCloseTo(FILES_DEFAULT_PX);
  });

  it('shrinks the file list to leave the document its minimum width, but never below the files minimum [unit]', () => {
    // 520px: 224px files would leave the document under 320px.
    expect(filesPx(520)).toBeCloseTo(520 - DOCUMENT_MIN_PX);
    // 300px: can't satisfy both minimums; files keeps its own.
    expect(filesPx(300)).toBeCloseTo(FILES_MIN_PX);
  });

  it(`never exceeds the ${FILES_MAX_PERCENT}% files maximum [unit]`, () => {
    // At 540px, 224px would be ~41% — it must be capped at 40% (216px).
    expect(documentDefaultLayout(540)[FILES]!).toBeLessThanOrEqual(FILES_MAX_PERCENT + 1e-9);
    expect(filesPx(540)).toBeCloseTo(216);
  });

  it('falls back to a sane split when the group has not been measured yet (width 0) [unit]', () => {
    const layout = documentDefaultLayout(0);
    expect(layout[FILES]! + layout[DOC]!).toBeCloseTo(100);
    expect(Number.isFinite(layout[FILES])).toBe(true);
  });
});
