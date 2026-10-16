import { render, screen } from '@testing-library/preact';
import { MarkdownWidget } from '@/pages/dashboard/markdown-widget';
import type { MarkdownWidget as MarkdownWidgetData } from '@/pages/dashboard/types';

// @/components/markdown is globally stubbed (see jest.config.js and
// test/__mocks__/markdown.tsx) to render its children verbatim in a div —
// real markdown parsing is covered by test/markdown.test.tsx. These tests
// only confirm this component wires the widget's fields through correctly.

function widget(overrides: Partial<MarkdownWidgetData> = {}): MarkdownWidgetData {
  return {
    id: 'w1',
    type: 'markdown',
    title: 'My Title',
    subtitle: 'My Subtitle',
    content: '# hi',
    ...overrides,
  };
}

describe('MarkdownWidget', () => {
  it("passes the widget's title and subtitle to WidgetCard [unit]", () => {
    render(<MarkdownWidget widget={widget()} />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('My Subtitle')).toBeInTheDocument();
  });

  it('passes content through to Markdown [unit]', () => {
    render(<MarkdownWidget widget={widget({ content: '# hi' })} />);
    expect(screen.getByText('# hi')).toBeInTheDocument();
  });

  it('omits subtitle markup when absent [unit]', () => {
    const { container } = render(<MarkdownWidget widget={widget({ subtitle: undefined })} />);
    expect(container.querySelector('p')).toBeNull();
  });
});
