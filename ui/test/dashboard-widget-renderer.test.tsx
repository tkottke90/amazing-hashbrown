import { render, screen } from '@testing-library/preact';
import { WidgetRenderer } from '@/pages/dashboard/widget-renderer';
import type { DashboardWidget, MarkdownWidget } from '@/pages/dashboard/types';

describe('WidgetRenderer', () => {
  it('dispatches a markdown widget to MarkdownWidget [unit]', () => {
    const widget: MarkdownWidget = {
      id: 'w1',
      type: 'markdown',
      title: 'My Title',
      content: 'hello',
    };
    render(<WidgetRenderer widget={widget} />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('throws via assertNever for an unhandled widget type [unit]', () => {
    const bad = { id: 'x', type: 'unknown-type', title: 'T' } as unknown as DashboardWidget;
    // Called directly as a function (not rendered) so the thrown error
    // is asserted without depending on how Preact propagates a
    // function-component throw through testing-library's render().
    expect(() => WidgetRenderer({ widget: bad })).toThrow('Unhandled widget type: unknown-type');
  });
});
