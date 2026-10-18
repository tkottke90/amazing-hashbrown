jest.mock('@/services/dashboard-api', () => ({
  fetchWidgets: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  deleteWidget: jest.fn(),
  reorderWidget: jest.fn(),
  resizeWidget: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/hooks/use-dashboard-widgets', () => ({
  ...jest.requireActual('@/hooks/use-dashboard-widgets'),
  patchDashboardWidget: jest.fn(),
}));

import { render, screen, fireEvent } from '@testing-library/preact';
import { WidgetRenderer } from '@/pages/dashboard/widget-renderer';
import { ThemeProvider } from '@/hooks/use-theme';
import * as dashboardApi from '@/services/dashboard-api';
import { patchDashboardWidget } from '@/hooks/use-dashboard-widgets';
import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockResizeWidget = dashboardApi.resizeWidget as jest.MockedFunction<
  typeof dashboardApi.resizeWidget
>;
const mockPatchDashboardWidget = patchDashboardWidget as jest.MockedFunction<
  typeof patchDashboardWidget
>;

const noop = () => {};

describe('WidgetRenderer', () => {
  it('dispatches an ok markdown result to MarkdownWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: {
        id: 'w1',
        type: 'markdown',
        title: 'My Title',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        content: 'hello',
      },
    };
    render(<WidgetRenderer result={result} onChanged={noop} />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('dispatches an ok big-number result to BigNumberWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: {
        id: 'w2',
        type: 'big-number',
        title: 'Messages',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        value: 5,
        unit: 'msgs',
      },
    };
    render(<WidgetRenderer result={result} onChanged={noop} />);
    expect(screen.getByTestId('big-number-widget')).toBeInTheDocument();
  });

  it('dispatches an ok line-graph result to LineGraphWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: {
        id: 'w3',
        type: 'line-graph',
        title: 'Response time',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        data: 'label,value\n09:00,120',
      },
    };
    // Wrapped in ThemeProvider: the widget's own edit-drawer Form tab
    // mounts a CSV CodeEditor immediately for this type (unlike Markdown).
    render(
      <ThemeProvider>
        <WidgetRenderer result={result} onChanged={noop} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('line-graph-widget')).toBeInTheDocument();
  });

  it('dispatches an ok pie-graph result to PieGraphWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: {
        id: 'w4',
        type: 'pie-graph',
        title: 'Agent usage',
        order: 0,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        data: 'label,value\nQuery,30\nAnalysis,25',
      },
    };
    render(
      <ThemeProvider>
        <WidgetRenderer result={result} onChanged={noop} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pie-graph-widget')).toBeInTheDocument();
  });

  it('dispatches an error result to the error card, which opens straight onto Raw [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'error',
      id: 'broken',
      raw: '---\nbad\n---',
      error: 'Invalid widget frontmatter: title: Required',
    };
    // Wrapped in ThemeProvider: an error result's drawer opens straight onto
    // the Raw tab, which mounts the CodeMirror-based CodeEditor immediately.
    render(
      <ThemeProvider>
        <WidgetRenderer result={result} onChanged={noop} />
      </ThemeProvider>,
    );
    expect(screen.getByText('Unable to load this widget')).toBeInTheDocument();
    expect(screen.getByText(/Invalid widget frontmatter/)).toBeInTheDocument();
  });

  it('throws via assertNever for an unhandled widget type [unit]', () => {
    const bad = {
      id: 'x',
      type: 'unknown-type',
      title: 'T',
      order: 0,
    } as unknown as DashboardWidget;
    const result: WidgetLoadResult = { status: 'ok', widget: bad };
    // Called directly as a function (not rendered) so the thrown error
    // is asserted without depending on how Preact propagates a
    // function-component throw through testing-library's render().
    expect(() => WidgetRenderer({ result, onChanged: noop })).toThrow(
      'Unhandled widget type: unknown-type',
    );
  });

  describe('resize wiring [orchestration]', () => {
    function pointer(type: string, init: { clientX: number; clientY: number }) {
      return new PointerEvent(type, { ...init, pointerId: 1, bubbles: true, cancelable: true });
    }

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('calls resizeWidget with the current widget plus the new w/h, then patches the result [orchestration]', async () => {
      const widget: DashboardWidget = {
        id: 'w2',
        type: 'big-number',
        title: 'Messages',
        order: 0,
        w: 2,
        h: 2,
        source: 'manual',
        updatedAt: '2026-01-01T00:00:00.000Z',
        value: 5,
      };
      const resized = { ...widget, w: 4, h: 3 };
      mockResizeWidget.mockResolvedValue(resized);
      const result: WidgetLoadResult = { status: 'ok', widget };

      render(<WidgetRenderer result={result} onChanged={noop} editMode />);
      const card = screen.getByTestId('widget-card');
      jest.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        width: 400,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const handle = screen.getByTestId('widget-resize-handle');

      // handle's onPointerDown is a JSX prop on an element with no native
      // onpointerdown IDL in this jsdom, so Preact registers it under the
      // literal mixed-case "PointerDown" (see dashboard-widget-card.test.tsx
      // for the full explanation) — only this first dispatch needs that.
      fireEvent(handle, pointer('PointerDown', { clientX: 0, clientY: 0 }));
      fireEvent(window, pointer('pointermove', { clientX: 200, clientY: 0 })); // +1 column
      fireEvent(window, pointer('pointerup', { clientX: 200, clientY: 0 }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockResizeWidget).toHaveBeenCalledWith('default', widget, 3, 2);
      expect(mockPatchDashboardWidget).toHaveBeenCalledWith('default', resized);
    });
  });
});
