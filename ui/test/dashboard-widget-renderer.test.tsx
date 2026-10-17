import { render, screen } from '@testing-library/preact';
import { WidgetRenderer } from '@/pages/dashboard/widget-renderer';
import { ThemeProvider } from '@/hooks/use-theme';
import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

const noop = () => {};

describe('WidgetRenderer', () => {
  it('dispatches an ok markdown result to MarkdownWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: { id: 'w1', type: 'markdown', title: 'My Title', order: 0, content: 'hello' },
    };
    render(<WidgetRenderer result={result} onChanged={noop} />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('dispatches an ok big-number result to BigNumberWidget [unit]', () => {
    const result: WidgetLoadResult = {
      status: 'ok',
      widget: { id: 'w2', type: 'big-number', title: 'Messages', order: 0, value: 5, unit: 'msgs' },
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
});
