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

  it('omits the provenance footer entirely when no source/updatedAt is given [unit]', () => {
    render(<WidgetCard title="My Widget">content</WidgetCard>);
    expect(screen.queryByTestId('widget-card-provenance')).not.toBeInTheDocument();
  });

  it('renders a "Manual" badge for a manual-sourced widget [unit]', () => {
    render(
      <WidgetCard title="My Widget" source="manual">
        content
      </WidgetCard>,
    );
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent('Manual');
  });

  it('renders a plain "Agent" badge when source is agent and no maintainer is set [unit]', () => {
    render(
      <WidgetCard title="My Widget" source="agent">
        content
      </WidgetCard>,
    );
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent('Agent');
  });

  it('renders "Agent · <maintainer>" when source is agent and a maintainer is set [unit]', () => {
    render(
      <WidgetCard title="My Widget" source="agent" maintainer="check-disk-space.sh">
        content
      </WidgetCard>,
    );
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent(
      'Agent · check-disk-space.sh',
    );
  });

  it('renders no badge for the reserved, inert "system" source (D12) [unit]', () => {
    render(
      <WidgetCard title="My Widget" source="system">
        content
      </WidgetCard>,
    );
    expect(screen.queryByTestId('widget-card-badge')).not.toBeInTheDocument();
  });

  it('renders a relative-time footer derived from updatedAt [unit]', () => {
    render(
      <WidgetCard title="My Widget" updatedAt={new Date().toISOString()}>
        content
      </WidgetCard>,
    );
    expect(screen.getByTestId('widget-card-updated-at')).toHaveTextContent('just now');
  });
});
