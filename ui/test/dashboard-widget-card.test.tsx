import { render, screen } from '@testing-library/preact';
import { WidgetCard } from '@/pages/dashboard/widget-card';

describe('WidgetCard', () => {
  it('renders the title and children [unit]', () => {
    render(
      <WidgetCard title="My Widget">
        <span>child content</span>
      </WidgetCard>,
    );
    expect(screen.getByText('My Widget')).toBeInTheDocument();
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('renders the subtitle when provided [unit]', () => {
    render(
      <WidgetCard title="My Widget" subtitle="My Subtitle">
        content
      </WidgetCard>,
    );
    expect(screen.getByText('My Subtitle')).toBeInTheDocument();
  });

  it('omits subtitle markup when absent, rather than rendering an empty element [unit]', () => {
    const { container } = render(<WidgetCard title="My Widget">content</WidgetCard>);
    expect(container.querySelector('p')).toBeNull();
  });
});
