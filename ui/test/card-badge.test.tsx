import { render, screen } from '@testing-library/preact';
import { CardBadge } from '@/components/card-badge';

function slot(name: string) {
  return document.querySelector(`[data-slot="${name}"]`);
}

describe('CardBadge', () => {
  it('renders its children as the badge text', () => {
    render(<CardBadge>Workspace</CardBadge>);
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('defaults to the blue variant', () => {
    render(<CardBadge>Workspace</CardBadge>);
    expect(slot('card-badge')).toHaveClass('bg-blue-100');
  });

  it('applies the violet variant when requested', () => {
    render(<CardBadge variant="violet">Project</CardBadge>);
    expect(slot('card-badge')).toHaveClass('bg-violet-100');
  });
});
