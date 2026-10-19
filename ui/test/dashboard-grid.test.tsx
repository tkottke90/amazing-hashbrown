import { render, screen, cleanup } from '@testing-library/preact';
import { DashboardGrid } from '@/pages/dashboard/dashboard-grid';
import { ThemeProvider } from '@/hooks/use-theme';
import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  deleteWidget: jest.fn(),
  reorderWidget: jest.fn(),
  resizeWidget: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

// jest.setup.ts stubs matchMedia to never match by default — swap in a fake
// MediaQueryList so useIsDesktopViewport() reports whatever this test needs.
function mockMatchMedia(matches: boolean) {
  return jest.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        matches,
        media,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }) as unknown as MediaQueryList,
  );
}

function makeResult(
  id: string,
  order: number,
  w: number,
  h: number,
  overrides: Partial<Extract<WidgetLoadResult, { status: 'ok' }>['widget']> = {},
): WidgetLoadResult {
  return {
    status: 'ok',
    widget: {
      id,
      type: 'markdown',
      title: id,
      order,
      w,
      h,
      source: 'manual',
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'x',
      ...overrides,
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
});

describe('DashboardGrid', () => {
  it('spans each widget by its own w/h at desktop viewport width [unit]', () => {
    mockMatchMedia(true);
    const results = [makeResult('a', 0, 6, 3), makeResult('b', 1, 3, 2)];
    render(
      <DashboardGrid
        results={results}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={false}
      />,
    );

    const cards = screen.getAllByTestId('widget-card');
    expect(cards[0]!.parentElement).toHaveStyle({ gridColumn: 'span 6', gridRow: 'span 3' });
    expect(cards[1]!.parentElement).toHaveStyle({ gridColumn: 'span 3', gridRow: 'span 2' });
  });

  it('renders a 12-column fixed track grid at desktop viewport width [unit]', () => {
    mockMatchMedia(true);
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 3, 2)]}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={false}
      />,
    );
    expect(screen.getByTestId('dashboard-grid')).toHaveStyle({
      gridTemplateColumns: 'repeat(12, 1fr)',
      gridAutoRows: '88px',
    });
  });

  it("uses Roomy's taller row height when the dashboard's density is roomy [unit]", () => {
    mockMatchMedia(true);
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 3, 2)]}
        dashboardId="default"
        density="roomy"
        onChanged={() => {}}
        editMode={false}
      />,
    );
    expect(screen.getByTestId('dashboard-grid')).toHaveStyle({ gridAutoRows: '120px' });
  });

  it('collapses to a single-column stack below the desktop breakpoint, ignoring w/h [unit]', () => {
    mockMatchMedia(false);
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 6, 3), makeResult('b', 1, 3, 2)]}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={false}
      />,
    );
    const grid = screen.getByTestId('dashboard-grid');
    expect(grid.style.gridTemplateColumns).toBe('');
    expect(screen.getAllByTestId('widget-card')).toHaveLength(2);
  });

  it('renders ok widgets sorted by order, independent of array position [unit]', () => {
    mockMatchMedia(false);
    const results = [makeResult('b', 1, 3, 2), makeResult('a', 0, 3, 2)];
    render(
      <DashboardGrid
        results={results}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={false}
      />,
    );
    const titles = screen
      .getAllByTestId('widget-card')
      .map((el) => el.querySelector('h2')?.textContent);
    expect(titles).toEqual(['a', 'b']);
  });

  it('renders no Ghost Cells outside Edit Mode [unit]', () => {
    mockMatchMedia(true);
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 3, 2)]}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={false}
      />,
    );
    expect(screen.queryAllByTestId('ghost-cell')).toHaveLength(0);
  });

  it('renders Ghost Cells only over cells no real widget occupies, non-interactively, in Edit Mode [unit]', () => {
    mockMatchMedia(true);
    // A single 3x2 widget: cells (1,1)-(2,3) are occupied, so no Ghost Cell
    // should ever declare that exact row/col start.
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 3, 2)]}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={true}
      />,
    );
    const ghosts = screen.getAllByTestId('ghost-cell');
    expect(ghosts.length).toBeGreaterThan(0);
    for (const ghost of ghosts) {
      expect(ghost).toHaveClass('pointer-events-none');
      expect(ghost).toHaveAttribute('aria-hidden', 'true');
      const row = ghost.style.gridRow;
      const col = ghost.style.gridColumn;
      const isOccupiedByWidget =
        (row === '1 / span 1' || row === '2 / span 1') &&
        (col === '1 / span 1' || col === '2 / span 1' || col === '3 / span 1');
      expect(isOccupiedByWidget).toBe(false);
    }
  });

  it('floors Ghost Cell rows at 5 for a near-empty dashboard in Edit Mode [unit]', () => {
    mockMatchMedia(true);
    render(
      <DashboardGrid
        results={[makeResult('a', 0, 3, 2)]}
        dashboardId="default"
        density="compact"
        onChanged={() => {}}
        editMode={true}
      />,
    );
    const ghosts = screen.getAllByTestId('ghost-cell');
    const maxRow = Math.max(...ghosts.map((g) => Number(g.style.gridRow.split(' ')[0])));
    expect(maxRow).toBe(5);
  });

  it('gives a fixed small span to a parse-error entry, never a real Widget Size [unit]', () => {
    mockMatchMedia(true);
    const results: WidgetLoadResult[] = [
      { status: 'error', id: 'broken', raw: '', error: 'bad frontmatter' },
    ];
    // Wrapped in ThemeProvider: the error card's drawer mounts a CodeMirror
    // CodeEditor immediately, same as dashboard-widget-renderer.test.tsx.
    render(
      <ThemeProvider>
        <DashboardGrid
          results={results}
          dashboardId="default"
          density="compact"
          onChanged={() => {}}
          editMode={false}
        />
      </ThemeProvider>,
    );
    const card = screen.getByTestId('widget-error-card');
    expect(card.parentElement).toHaveStyle({ gridColumn: 'span 3', gridRow: 'span 2' });
  });
});
