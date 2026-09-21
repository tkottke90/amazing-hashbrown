import { render, screen } from '@testing-library/preact';
import { ChatErrorDetail } from '@/components/chat-error-detail';

describe('ChatErrorDetail', () => {
  it('renders the generic message when no category is given', () => {
    render(<ChatErrorDetail />);
    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('renders category-specific copy for a known category', () => {
    render(<ChatErrorDetail category="network" />);
    expect(
      screen.getByText("Couldn't reach the provider — check your connection."),
    ).toBeInTheDocument();
  });

  it('renders neutral "stopped" copy for the cancelled category, not an error message', () => {
    render(<ChatErrorDetail category="cancelled" />);
    expect(screen.getByText('Stopped before finishing.')).toBeInTheDocument();
  });

  it('shows an expandable detail toggle when detail text is provided alongside a cancelled category', () => {
    render(<ChatErrorDetail category="cancelled" detail="Stopped." />);
    expect(screen.getByText('Show details')).toBeInTheDocument();
  });
});
