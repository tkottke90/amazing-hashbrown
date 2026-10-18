import { render, screen } from '@testing-library/preact';
import { WidgetFooter } from '@/pages/dashboard/widget-footer';

describe('WidgetFooter', () => {
  it('omits the provenance footer entirely when no source/updatedAt is given [unit]', () => {
    render(<WidgetFooter />);
    expect(screen.queryByTestId('widget-card-provenance')).not.toBeInTheDocument();
  });

  it('renders a "Manual" badge for a manual-sourced widget [unit]', () => {
    render(<WidgetFooter source="manual" />);
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent('Manual');
  });

  it('renders a plain "Agent" badge when source is agent and no maintainer is set [unit]', () => {
    render(<WidgetFooter source="agent" />);
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent('Agent');
  });

  it('renders "Agent · <maintainer>" when source is agent and a maintainer is set [unit]', () => {
    render(<WidgetFooter source="agent" maintainer="check-disk-space.sh" />);
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent(
      'Agent · check-disk-space.sh',
    );
  });

  it('renders a "System" badge for the system source (#320) [unit]', () => {
    render(<WidgetFooter source="system" />);
    expect(screen.getByTestId('widget-card-badge')).toHaveTextContent('System');
  });

  it('renders a relative-time footer derived from updatedAt [unit]', () => {
    render(<WidgetFooter updatedAt={new Date().toISOString()} />);
    expect(screen.getByTestId('widget-card-updated-at')).toHaveTextContent('just now');
  });
});
